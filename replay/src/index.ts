import * as core from '@actions/core';
import * as github from '@actions/github';
import axios, { AxiosRequestConfig } from 'axios';
import crypto from 'crypto';
import fs from 'fs/promises';
import * as jsyaml from 'js-yaml';
import stringify from 'json-stable-stringify';
import { Dictionary, flatten, get, groupBy, sumBy } from 'lodash';
import { z } from 'zod';

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
  originalTraceEvent: TraceEvent;
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

const zEnvSchema = z.object({
  AUTOBLOCKS_REPLAYS_FILEPATH: z.string().nonempty().default('replays.json'),
  GITHUB_REF_NAME: z.string().nonempty(),
  GITHUB_WORKSPACE: z.string().nonempty(),
});

const env = zEnvSchema.parse(process.env);

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
      headers: { Authorization: `Bearer ${args.apiKey}` },
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
    let replayedEventIdx = 0;

    // For each replay, find the original trace event to compare against
    for (const replayedTraceEvent of args.replays[traceId]) {
      const replayId = `${replayedEventIdx}-${replayedTraceEvent.message}`;

      // Right now we just find the first event with the same message,
      // but we might want to support more complex matching (like on message + properties)
      const originalTraceEvent = groupedTraces[traceId].find(
        (event) => event.message === replayedTraceEvent.message,
      );
      if (!originalTraceEvent) {
        core.warning(`Could not find a matching event for replay ${replayId}`);
        // TODO: keep this instead of continuing, and show nothing for the replayed event
        // in the table
        continue;
      }
      core.info(`Found matching event for replay ${replayId}`);

      // Remove the found trace event from the array so that it is not matched again, and also remove
      // any events that came before it
      groupedTraces[traceId] = groupedTraces[traceId].filter(
        (event) =>
          event.id !== originalTraceEvent.id &&
          event.timestamp >= originalTraceEvent.timestamp,
      );

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
 * Makes a base64-encoded string for committing to GitHub.
 *
 * We use `stringify` from json-stable-stringify instead of `JSON.stringify` since the latter
 * is not stable and will sometimes write keys in different orders.
 */
const makeCommitContent = (event: {
  message: string;
  properties: Record<string, unknown>;
}) => {
  return Buffer.from(
    // Note we don't do stringify(event) because we only want to include
    // the message and properties, not the traceId, timestamp, etc.
    stringify(
      { message: event.message, properties: event.properties },
      { space: 2 },
    ) + '\n',
  ).toString('base64');
};

/**
 * Build the markdown comment to post to GitHub.
 */
const makeCommitComment = (args: {
  table: TableRow[];
  replayedEvents: ReplayableEvent[];
  github: typeof github;
}): string => {
  const rows = ['# Autoblocks Replay Results', ''];

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

const main = async () => {
  const replayMethod = core.getInput('replay-method', { required: true });
  const replayUrl = core.getInput('replay-url', { required: true });
  const replayViewId = core.getInput('replay-view-id', { required: true });
  const replayNumTraces = core.getInput('replay-num-traces', {
    required: true,
  });
  const replayTransformConfig = core.getInput('replay-transform-config');
  const autoblocksApiKey = core.getInput('autoblocks-api-key', {
    required: true,
  });
  const githubToken = core.getInput('github-token', { required: true });

  const octokit = github.getOctokit(githubToken);

  const { traces } = await fetchTraces({
    viewId: replayViewId,
    pageSize: replayNumTraces,
    apiKey: autoblocksApiKey,
  });
  core.info(`Found ${traces.length} traces`);
  core.debug(JSON.stringify(traces, null, 2));

  const replayConfig = parseReplayTransformConfig(replayTransformConfig);
  core.info(`Replay transform config:`);
  core.info(JSON.stringify(replayConfig, null, 2));

  const replayableEvents = findReplayableTraceEvents({
    traces,
    isReplayable: (event) =>
      replayConfig.filters.every(
        (filter) => get(event, filter.key) === filter.value,
      ),
    makeReplayPayload: (event) => {
      const payload: Record<string, unknown> = {};
      for (const mapper of replayConfig.mappers) {
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
    };
    const { status, statusText } = await axios(request);
    core.info(`The response is: [${status}] ${statusText}`);
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
  const randomBranchNamePrefix = crypto.randomUUID();

  const makeBranchName = (
    branchType: 'original' | 'replayed',
    traceId: string,
  ) => `autoblocks-replays/${randomBranchNamePrefix}/${traceId}/${branchType}`;

  const repoArgs = {
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
  };

  const commitArgs = {
    ...repoArgs,
    // `sha` needs to be explicitly set to undefined when creating a new file that doesn't already exist
    // `sha` will be overwritten when we're overwriting an existing file
    sha: undefined,
    committer: {
      name: 'autoblocks',
      email: 'github-actions@autoblocks.ai',
    },
  };

  const getCommitDifferences = async (args: {
    base: string;
    head: string;
  }): Promise<{ additions: number; deletions: number }> => {
    const {
      data: { files },
    } = await octokit.rest.repos.compareCommits({
      ...repoArgs,
      base: args.base,
      head: args.head,
    });

    return {
      additions: sumBy(files, 'additions'),
      deletions: sumBy(files, 'deletions'),
    };
  };

  // Keep track of information related to the commits to the `original` branch
  const originalHeadShas: Dictionary<string> = {};
  const originalContentUrls: Dictionary<string> = {};
  const originalContentShas: Dictionary<string> = {};

  for (const traceId of Object.keys(comparisons)) {
    core.info(`Committing originals for trace ${traceId}`);

    // Create a new branch for committing the original events for this trace
    const originalBranchName = makeBranchName('original', traceId);
    await octokit.rest.git.createRef({
      ...repoArgs,
      ref: `refs/heads/${originalBranchName}`,
      sha: github.context.sha,
    });
    core.info(`Created branch ${originalBranchName}`);

    // Keep track of the head sha of this branch, we'll need it later when
    // creating the branch for the replayed events
    let headSha = github.context.sha;

    for (const comparison of comparisons[traceId]) {
      const { id: comparisonId, originalTraceEvent } = comparison;
      const key = `${traceId}-${comparisonId}`;

      core.info(`Committing original event for ${comparisonId}`);
      const {
        data: { content, commit },
      } = await octokit.rest.repos.createOrUpdateFileContents({
        ...commitArgs,
        branch: originalBranchName,
        path: `${comparisonId}.json`,
        message: `${comparisonId}`,
        content: makeCommitContent(originalTraceEvent),
      });

      originalContentUrls[key] = content?.html_url as string;
      originalContentShas[key] = content?.sha as string;

      // Update the head sha of the branch w/ the latest commit
      headSha = commit.sha as string;
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
    await octokit.rest.git.createRef({
      ...repoArgs,
      ref: `refs/heads/${replayedBranchName}`,
      sha: originalHeadShas[traceId],
    });
    core.info(`Created branch ${replayedBranchName}`);

    // Keep track of the head sha of this branch, we'll need it later when
    // comparing the head of the `replayed` branch to the head of the `original` branch
    let headSha = originalHeadShas[traceId];

    for (const comparison of comparisons[traceId]) {
      const { id: comparisonId, replayedTraceEvent } = comparison;
      const key = `${traceId}-${comparisonId}`;

      // Get current head commit of replayed branch, we need it to get a diff between the original
      // event and the replayed event
      const {
        data: {
          object: { sha: headShaOfReplayedBranchBeforeCommit },
        },
      } = await octokit.rest.git.getRef({
        ...repoArgs,
        ref: `heads/${replayedBranchName}`,
      });

      core.info(`Committing replayed event for ${comparisonId}`);
      const {
        data: { content, commit },
      } = await octokit.rest.repos.createOrUpdateFileContents({
        ...commitArgs,
        branch: replayedBranchName,
        path: `${comparisonId}.json`,
        message: `${comparisonId} replay`,
        content: makeCommitContent(replayedTraceEvent),
        // This file already exists, since the `replayed` branch was created from the `original`
        // branch and we are committing to the same file path. So we need to set the sha to the
        // sha of the pre-existing file.
        sha: originalContentShas[key],
      });

      replayedContentUrls[key] = content?.html_url as string;

      // Update the head sha of the branch w/ the latest commit
      headSha = commit.sha as string;

      // Get the diff between the original event and the replayed event by
      // comparing the commit before the replayed event was committed to the
      // branch with the commit of the replayed event
      const { additions, deletions } = await getCommitDifferences({
        base: headShaOfReplayedBranchBeforeCommit as string,
        head: commit.sha as string,
      });

      replayedDiffs[key] = {
        url: commit.html_url as string,
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
    const { additions, deletions } = await getCommitDifferences({
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

  // Comment on commit
  await octokit.rest.repos.createCommitComment({
    ...repoArgs,
    commit_sha: github.context.sha,
    body: makeCommitComment({
      table,
      replayedEvents: replayableEvents,
      github,
    }),
  });
};

main();
