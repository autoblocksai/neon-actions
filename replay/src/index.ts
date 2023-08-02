import * as core from '@actions/core';
import * as github from '@actions/github';
import axios, { AxiosRequestConfig } from 'axios';
import fs from 'fs/promises';
import * as jsyaml from 'js-yaml';
import stringify from 'json-stable-stringify';
import { Dictionary, flatten, get, groupBy, sumBy, omit } from 'lodash';
import { nanoid } from 'nanoid';
import { z } from 'zod';

type Octokit = ReturnType<typeof github.getOctokit>;

interface TraceEvent {
  id: string;
  traceId: string;
  message: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

interface Trace {
  id: string;
  events: TraceEvent[];
}

interface ReplayTransformConfig {
  filters: { key: string; value: string }[];
  mappers: { key: string; value: string }[];
}

interface ReplayableEvent {
  originalEvent: TraceEvent;
  replayPayload: unknown;
}

interface TraceEventReplay {
  traceId: string;
  message: string;
  properties: Record<string, unknown>;
}

interface TraceEventComparison {
  id: string;
  originalTraceEvent: TraceEvent | undefined;
  replayedTraceEvent: TraceEventReplay;
}

interface CommitComparison {
  url: string;
  additions: number;
  deletions: number;
}

interface TableRow {
  traceId: string;
  message: string;
  originalContentUrl: string;
  replayedContentUrl: string;
  diff: CommitComparison;
}

/**
 * See https://docs.github.com/en/actions/learn-github-actions/variables#default-environment-variables for
 * a description of the default environment variables available during a GitHub Actions workflow run.
 */
const zEnvSchema = z.object({
  AUTOBLOCKS_REPLAYS_FILEPATH: z.string().nonempty().default('replays.json'),
  GITHUB_REF_NAME: z.string().nonempty(),
  GITHUB_REPOSITORY: z.string().nonempty(),
  GITHUB_SHA: z.string().nonempty(),
  GITHUB_WORKSPACE: z.string().nonempty(),
});

const env = zEnvSchema.parse(process.env);

/**
 * Users specify to us how to transform and filter their events for processing in YAML.
 *
 * We filter events based on the key-value pairs under `filters` using Lodash's _.get:
 *
 * ```
 * filters:
 *   properties.userId: 123
 * ```
 *
 * Results in us only replaying events where: `_.get(event, 'properties.userId') === 123`
 *
 * The mappers under `mappers` specify how to transform the event payload before replaying it:
 *
 * ```
 * mappers:
 *   query: properties.query
 *   __hiddenTraceId: traceId
 * ```
 *
 * Will cause us to pass:
 *
 * ```
 * { query: _.get(event, 'properties.query'), __hiddenTraceId: _.get(event, 'traceId') }
 * ```
 *
 * to the replay entrypoint.
 */
const parseReplayTransformConfig = (rawYaml: string): ReplayTransformConfig => {
  if (!rawYaml) {
    return { filters: [], mappers: [] };
  }

  try {
    const parsed = jsyaml.load(rawYaml) as Record<
      'filters' | 'mappers',
      Record<string, string>
    >;
    if (typeof parsed !== 'object') {
      throw new Error();
    }
    return {
      filters: Object.entries(parsed.filters || {}).map(([key, value]) => ({
        key,
        value,
      })),
      mappers: Object.entries(parsed.mappers || {}).map(([key, value]) => ({
        key,
        value,
      })),
    };
  } catch {
    const msg = 'replay-transform-config must be valid YAML';
    core.error(msg);
    throw new Error(msg);
  }
};

/**
 * Users specify to us which properties to filter out of their events in YAML.
 *
 * The key is the message of the event the filter should apply to, and the value
 * is a list of properties to filter out.
 *
 * ```
 * ai.response:
 *   - response.id
 *   - response.created
 * ```
 *
 * This will cause us to call _.omit(event.properties, ['response.id', 'response.created']) on all
 * events where event.message === 'ai.response'.
 */
const parsePropertyFilterConfig = (
  rawYaml: string,
): Record<string, string[]> => {
  if (!rawYaml) {
    return {};
  }

  try {
    const parsed = jsyaml.load(rawYaml) as Record<string, string[]>;
    if (typeof parsed !== 'object') {
      throw new Error();
    }

    // Validate `parsed` is an object with array values
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) {
        throw new Error();
      }
    }

    return parsed;
  } catch {
    const msg =
      'property-filter-config must be valid YAML consisting of keys whose values are arrays of strings';
    core.error(msg);
    throw new Error(msg);
  }
};

/**
 * Fetch traces from the Autoblocks API.
 */
const fetchTraces = async (args: {
  viewId: string;
  pageSize: string;
  apiKey: string;
}): Promise<{ traces: Trace[] }> => {
  const { data } = await axios.get(
    `https://api.autoblocks.ai/views/${args.viewId}/traces`,
    {
      params: { pageSize: args.pageSize },
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'X-Autoblocks-Sha': env.GITHUB_SHA,
        'X-Autoblocks-Ref': env.GITHUB_REF_NAME,
        'X-Autoblocks-Repo': env.GITHUB_REPOSITORY,
      },
    },
  );
  return data;
};

const findReplayableTraceEvents = (args: {
  traces: Trace[];
  isReplayable: (event: TraceEvent) => boolean;
  makeReplayPayload: (event: TraceEvent) => unknown;
}): ReplayableEvent[] => {
  const replayable: { originalEvent: TraceEvent; replayPayload: unknown }[] =
    [];
  for (const trace of args.traces) {
    for (const event of trace.events) {
      if (args.isReplayable(event)) {
        replayable.push({
          originalEvent: event,
          replayPayload: args.makeReplayPayload(event),
        });
      }
    }
  }
  return replayable;
};

/**
 * The replayed events are written to a file by the Autoblocks SDK.
 */
const loadReplays = async (): Promise<Dictionary<TraceEventReplay[]>> => {
  try {
    const fileContent = await fs.readFile(
      `${env.GITHUB_WORKSPACE}/${env.AUTOBLOCKS_REPLAYS_FILEPATH}`,
      'utf8',
    );
    const parsedContent = JSON.parse(fileContent) as TraceEventReplay[];
    return groupBy(parsedContent, 'traceId');
  } catch {
    return {};
  }
};

/**
 * Match each replayed event with an original event.
 */
const makeComparisonPairs = (args: {
  traces: Trace[];
  replays: Dictionary<TraceEventReplay[]>;
}): Dictionary<TraceEventComparison[]> => {
  const comparisons: Dictionary<TraceEventComparison[]> = {};

  // Group the original trace events by trace id
  const groupedTraces = groupBy(
    flatten(args.traces.map((t) => t.events)),
    'traceId',
  );

  for (const traceId of Object.keys(args.replays)) {
    core.info(`Making comparison pairs for trace ${traceId}`);
    comparisons[traceId] = [];

    // Maintain a counter so that the files can be ordered
    let replayedEventIdx = 1;

    // For each replay, find the original trace event to compare against
    for (const replayedTraceEvent of args.replays[traceId]) {
      const replayId = `${replayedEventIdx}-${replayedTraceEvent.message}`;

      // Right now we just find the first event with the same message,
      // but we might want to support more complex matching (like on message + properties)
      const originalTraceEvent = groupedTraces[traceId].find(
        (event) => event.message === replayedTraceEvent.message,
      );
      if (originalTraceEvent) {
        core.info(`Found matching event for replay ${replayId}`);

        // Remove the found trace event from the array so that it is not matched again, and also remove
        // any events that came before it
        groupedTraces[traceId] = groupedTraces[traceId].filter(
          (event) =>
            event.id !== originalTraceEvent.id &&
            event.timestamp >= originalTraceEvent.timestamp,
        );
      } else {
        core.warning(`Could not find a matching event for replay ${replayId}`);
      }

      comparisons[traceId].push({
        id: replayId,
        originalTraceEvent,
        replayedTraceEvent,
      });

      replayedEventIdx++;
    }
  }

  return comparisons;
};

/**
 * We use `stringify` from json-stable-stringify instead of `JSON.stringify` since the latter
 * is not stable and will sometimes write keys in different orders.
 */
const stringifyEvent = (args: {
  event: {
    message: string;
    properties: Record<string, unknown>;
  };
  propertyFilterConfig: Record<string, string[]>;
}) => {
  // Filter out any properties on the event that the user has specified to filter out
  const filters = args.propertyFilterConfig[args.event.message];
  const filteredProperties = filters
    ? omit(args.event.properties, filters)
    : args.event.properties;

  // Note we don't do stringify(event) because we only want to include
  // the message and properties, not the traceId, timestamp, etc.
  return (
    stringify(
      { message: args.event.message, properties: filteredProperties },
      { space: 2 },
    ) + '\n'
  );
};

/**
 * Build the markdown comment to post to GitHub.
 */
const makeCommitComment = (args: {
  table: TableRow[];
  replayedEvents: ReplayableEvent[];
}): string => {
  const rows = ['# Autoblocks Replay Results'];

  const groupedRows = groupBy(args.table, 'traceId');
  for (const traceId of Object.keys(groupedRows)) {
    rows.push('');
    rows.push(
      `## Trace [\`${traceId}\`](https://app.autoblocks.ai/explore/trace/${traceId})`,
    );
    rows.push('');
    rows.push('### Replay Inputs');
    for (const replayedEvent of args.replayedEvents.filter(
      (event) => event.originalEvent.traceId === traceId,
    )) {
      rows.push('');
      rows.push(
        `#### \`${replayedEvent.originalEvent.message}\` - \`${replayedEvent.originalEvent.id}\``,
      );
      rows.push('```');
      rows.push(JSON.stringify(replayedEvent.replayPayload, null, 2));
      rows.push('```');
    }
    rows.push('### Replay Outputs');
    rows.push('');
    rows.push('| Message | Original | Replay | Difference |');
    rows.push('| ------- | -------- | ------ | ---------- |');
    for (const row of groupedRows[traceId]) {
      rows.push(
        `| \`${row.message}\` | [Original](${row.originalContentUrl}) | [Replay](${row.replayedContentUrl}) | [\`+${row.diff.additions} / -${row.diff.deletions}\`](${row.diff.url}) |`,
      );
    }
  }
  return rows.join('\n');
};

class GitHubAPI {
  private octokit: Octokit;

  constructor(octokit: Octokit) {
    this.octokit = octokit;
  }

  private ownerAndRepo(): { owner: string; repo: string } {
    return {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
    };
  }

  private encodeContent(content: string): string {
    return Buffer.from(content).toString('base64');
  }

  async getCommitDifferences(args: {
    base: string;
    head: string;
  }): Promise<{ additions: number; deletions: number }> {
    const {
      data: { files },
    } = await this.octokit.rest.repos.compareCommits({
      ...this.ownerAndRepo(),
      base: args.base,
      head: args.head,
    });

    return {
      additions: sumBy(files, 'additions'),
      deletions: sumBy(files, 'deletions'),
    };
  }

  async createBranch(args: { name: string; sha: string }): Promise<void> {
    await this.octokit.rest.git.createRef({
      ...this.ownerAndRepo(),
      ref: `refs/heads/${args.name}`,
      sha: args.sha,
    });
  }

  async getHeadShaOfBranch(args: { name: string }): Promise<string> {
    const {
      data: {
        object: { sha },
      },
    } = await this.octokit.rest.git.getRef({
      ...this.ownerAndRepo(),
      ref: `heads/${args.name}`,
    });

    return sha as string;
  }

  async commitContent(args: {
    branch: string;
    path: string;
    message: string;
    content: string;
    // `sha` is undefined when creating a new file, and is required when updating an existing file
    sha: string | undefined;
  }): Promise<{
    commitSha: string;
    commitUrl: string;
    contentSha: string;
    contentUrl: string;
  }> {
    const {
      data: { commit, content },
    } = await this.octokit.rest.repos.createOrUpdateFileContents({
      ...this.ownerAndRepo(),
      branch: args.branch,
      path: args.path,
      message: args.message,
      content: this.encodeContent(args.content),
      sha: args.sha,
      committer: {
        name: 'autoblocks',
        email: 'github-actions@autoblocks.ai',
      },
    });

    return {
      commitSha: commit.sha as string,
      commitUrl: commit.html_url as string,
      contentSha: content?.sha as string,
      contentUrl: content?.html_url as string,
    };
  }

  async commentOnCommit(args: { sha: string; body: string }): Promise<void> {
    await this.octokit.rest.repos.createCommitComment({
      ...this.ownerAndRepo(),
      commit_sha: args.sha,
      body: args.body,
    });
  }

  /**
   * Iterates through all the comments on a PR and returns the ID of the first comment that contains the given text.
   */
  private async findCommentWithTextInBody(args: {
    pullNumber: number;
    searchString: string;
  }): Promise<number | undefined> {
    const iterator = this.octokit.paginate.iterator(
      this.octokit.rest.issues.listComments,
      {
        ...this.ownerAndRepo(),
        issue_number: args.pullNumber,
        per_page: 100,
      },
    );

    // iterate through each response
    for await (const { data: comments } of iterator) {
      for (const comment of comments) {
        if (comment.body?.includes(args.searchString)) {
          return comment.id;
        }
      }
    }

    return undefined;
  }

  async commentOnPullRequestedAssociatedWithCommit(args: {
    sha: string;
    body: string;
  }): Promise<void> {
    const { data: pulls } =
      await this.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        ...this.ownerAndRepo(),
        commit_sha: args.sha,
      });
    if (!pulls || pulls.length === 0) {
      core.info(`No pull requests associated with commit ${args.sha}`);
      return;
    }

    const pull = pulls[0];
    core.info(`Found pull request associated with commit ${pull.html_url}`);

    const autoblocksComment = '<!-- autoblocks-comment -->';
    const commentBody = `${args.body}\n\n${autoblocksComment}`;

    const existingCommentId = await this.findCommentWithTextInBody({
      pullNumber: pull.number,
      searchString: autoblocksComment,
    });

    if (existingCommentId) {
      // Update existing comment
      core.info(`Updating existing comment ${existingCommentId}`);
      await this.octokit.rest.issues.updateComment({
        ...this.ownerAndRepo(),
        comment_id: existingCommentId,
        // For now we just overwrite the comment. Ideally we maintain a list of old results at the bottom
        body: commentBody,
      });
    } else {
      // Otherwise, create a new comment on the pull request
      core.info(`Creating new comment`);
      await this.octokit.rest.issues.createComment({
        ...this.ownerAndRepo(),
        issue_number: pull.number,
        body: commentBody,
      });
    }
  }
}

const main = async () => {
  const replayMethod = core.getInput('replay-method', { required: true });
  const replayUrl = core.getInput('replay-url', { required: true });
  const replayViewId = core.getInput('replay-view-id', { required: true });
  const replayNumTraces = core.getInput('replay-num-traces', {
    required: true,
  });
  const replayTransformConfigRaw = core.getInput('replay-transform-config');
  const propertyFilterConfigRaw = core.getInput('property-filter-config');
  const autoblocksApiKey = core.getInput('autoblocks-api-key', {
    required: true,
  });
  const githubToken = core.getInput('github-token', { required: true });

  const octokit = github.getOctokit(githubToken);
  const gitHubApi = new GitHubAPI(octokit);

  const { traces } = await fetchTraces({
    viewId: replayViewId,
    pageSize: replayNumTraces,
    apiKey: autoblocksApiKey,
  });
  core.info(`Found ${traces.length} traces`);
  core.debug(JSON.stringify(traces, null, 2));

  const replayTransformConfig = parseReplayTransformConfig(
    replayTransformConfigRaw,
  );
  core.info(`Replay transform config:`);
  core.info(JSON.stringify(replayTransformConfig, null, 2));

  const propertyFilterConfig = parsePropertyFilterConfig(
    propertyFilterConfigRaw,
  );

  const replayableEvents = findReplayableTraceEvents({
    traces,
    isReplayable: (event) =>
      replayTransformConfig.filters.every(
        (filter) => get(event, filter.key) === filter.value,
      ),
    makeReplayPayload: (event) => {
      if (replayTransformConfig.mappers.length === 0) {
        // Replay the event's properties as-is if there are no mappers
        return event.properties;
      }

      // Otherwise, use the mappers to build the replay payload
      const payload: Record<string, unknown> = {};
      for (const mapper of replayTransformConfig.mappers) {
        const payloadKey = mapper.key;
        const payloadValue = get(event, mapper.value);
        payload[payloadKey] = payloadValue;
      }
      return payload;
    },
  });

  core.info(`Found ${replayableEvents.length} replayable events`);
  core.debug(JSON.stringify(replayableEvents, null, 2));

  // Replay events
  for (const replayableEvent of replayableEvents) {
    const { originalEvent, replayPayload } = replayableEvent;
    core.info(
      `Replaying event ${originalEvent.traceId}-${originalEvent.message}`,
    );
    const request: AxiosRequestConfig = {
      url: replayUrl,
      method: replayMethod,
      data: replayPayload,
      headers: {
        'X-Autoblocks-Replay-Trace-Id': originalEvent.traceId,
      },
    };
    try {
      const { status, statusText } = await axios(request);
      if (status < 200 || status >= 300) {
        throw new Error(`[${status}] ${statusText}`);
      }
      core.info(`The replay request succeeded: [${status}] ${statusText}`);
    } catch (err) {
      core.error(`The replay request failed: ${err}`);
    }
  }

  // Load the replayed events that were written to a file by the Autoblocks SDK during the replays above
  const replays = await loadReplays();
  core.info(`Loaded ${Object.keys(replays).length} replays`);
  core.debug(JSON.stringify(replays, null, 2));

  // Match up each replayed event with an original event
  const comparisons = makeComparisonPairs({ traces, replays });

  core.info(`Made ${Object.keys(comparisons).length} comparison pairs`);
  core.debug(JSON.stringify(comparisons, null, 2));

  // Create a random ID for the branches we're going to create
  const randomBranchNamePrefix = nanoid(6);

  const makeBranchName = (
    branchType: 'original' | 'replayed',
    traceId: string,
  ) =>
    `autoblocks-replays/${env.GITHUB_REF_NAME}/${randomBranchNamePrefix}/${traceId}/${branchType}`;

  // Keep track of information related to the commits to the `original` branch
  const originalHeadShas: Dictionary<string> = {};
  const originalContentUrls: Dictionary<string> = {};
  const originalContentShas: Dictionary<string> = {};

  for (const traceId of Object.keys(comparisons)) {
    core.info(`Committing originals for trace ${traceId}`);

    // Create a new branch for committing the original events for this trace
    const originalBranchName = makeBranchName('original', traceId);
    await gitHubApi.createBranch({
      name: originalBranchName,
      sha: env.GITHUB_SHA,
    });
    core.info(`Created branch ${originalBranchName}`);

    // Keep track of the head sha of this branch, we'll need it later when
    // creating the branch for the replayed events
    let headSha = env.GITHUB_SHA;

    for (const comparison of comparisons[traceId]) {
      const { id: comparisonId, originalTraceEvent } = comparison;
      const key = `${traceId}-${comparisonId}`;

      core.info(`Committing original event for ${comparisonId}`);
      const { commitSha, contentSha, contentUrl } =
        await gitHubApi.commitContent({
          branch: originalBranchName,
          path: `${comparisonId}.json`,
          message: `${comparisonId}`,
          // If we weren't able to match the replayed event with an original event, we still write an empty
          // file here so that it shows up when diffing the replayed branch with the original branch.
          content: originalTraceEvent
            ? stringifyEvent({
                event: originalTraceEvent,
                propertyFilterConfig,
              })
            : '',
          sha: undefined,
        });

      originalContentUrls[key] = contentUrl;
      originalContentShas[key] = contentSha;

      // Update the head sha of the branch w/ the latest commit
      headSha = commitSha;
    }

    // The last sha from the loop above is the head sha of the branch
    originalHeadShas[traceId] = headSha;
  }

  // Keep track of information related to the commits to the `replayed` branch
  const replayedHeadShas: Dictionary<string> = {};
  const replayedContentUrls: Dictionary<string> = {};
  const replayedDiffs: Dictionary<CommitComparison> = {};

  for (const traceId of Object.keys(comparisons)) {
    core.info(`Committing replays for trace ${traceId}`);

    const replayedBranchName = makeBranchName('replayed', traceId);

    // The base sha for the `replayed` branch is the head sha of the `original` branch,
    // which makes it easy to compare the two branches
    let headSha = originalHeadShas[traceId];

    await gitHubApi.createBranch({
      name: replayedBranchName,
      sha: headSha,
    });
    core.info(`Created branch ${replayedBranchName}`);

    for (const comparison of comparisons[traceId]) {
      const { id: comparisonId, replayedTraceEvent } = comparison;
      const key = `${traceId}-${comparisonId}`;

      // Get current head commit of replayed branch, we need it to get a diff between the original
      // event and the replayed event
      const headShaOfReplayedBranchBeforeCommit =
        await gitHubApi.getHeadShaOfBranch({
          name: replayedBranchName,
        });

      core.info(`Committing replayed event for ${comparisonId}`);
      const { commitSha, commitUrl, contentUrl } =
        await gitHubApi.commitContent({
          branch: replayedBranchName,
          path: `${comparisonId}.json`,
          message: `${comparisonId} replay`,
          content: stringifyEvent({
            event: replayedTraceEvent,
            propertyFilterConfig,
          }),
          // This file already exists, since the `replayed` branch was created from the `original`
          // branch and we are committing to the same file path. So we need to set the sha to the
          // sha of the pre-existing file.
          sha: originalContentShas[key],
        });

      replayedContentUrls[key] = contentUrl;

      // Update the head sha of the branch w/ the latest commit
      headSha = commitSha;

      // Get the diff between the original event and the replayed event by
      // comparing the commit before the replayed event was committed to the
      // branch with the commit of the replayed event
      const { additions, deletions } = await gitHubApi.getCommitDifferences({
        base: headShaOfReplayedBranchBeforeCommit,
        head: commitSha,
      });

      replayedDiffs[key] = {
        url: commitUrl,
        additions,
        deletions,
      };
    }

    replayedHeadShas[traceId] = headSha;
  }

  // Make table
  const table: TableRow[] = [];
  for (const traceId of Object.keys(comparisons)) {
    for (const comparison of comparisons[traceId]) {
      const key = `${traceId}-${comparison.id}`;
      table.push({
        traceId,
        message: comparison.replayedTraceEvent.message,
        originalContentUrl: originalContentUrls[key],
        replayedContentUrl: replayedContentUrls[key],
        diff: replayedDiffs[key],
      });
    }

    // Get total diff between original and replayed branches
    const { additions, deletions } = await gitHubApi.getCommitDifferences({
      base: originalHeadShas[traceId],
      head: replayedHeadShas[traceId],
    });

    const githubUrl = `${github.context.serverUrl}/${github.context.repo.owner}/${github.context.repo.repo}`;
    const originalBranchName = makeBranchName('original', traceId);
    const replayedBranchName = makeBranchName('replayed', traceId);

    table.push({
      traceId,
      message: '--- ALL ---',
      originalContentUrl: `${githubUrl}/compare/${env.GITHUB_REF_NAME}...${originalBranchName}`,
      replayedContentUrl: `${githubUrl}/compare/${env.GITHUB_REF_NAME}...${replayedBranchName}`,
      diff: {
        url: `${githubUrl}/compare/${originalBranchName}...${replayedBranchName}`,
        additions,
        deletions,
      },
    });
  }

  core.debug('TABLE:');
  core.debug(JSON.stringify(table, null, 2));

  const comment = makeCommitComment({
    table,
    replayedEvents: replayableEvents,
  });
  // Comment on commit
  await gitHubApi.commentOnCommit({
    sha: env.GITHUB_SHA,
    body: comment,
  });
  // Comment on pull request (if there is one)
  await gitHubApi.commentOnPullRequestedAssociatedWithCommit({
    sha: env.GITHUB_SHA,
    body: comment,
  });
};

main();
