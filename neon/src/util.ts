import fs from 'fs';
import * as actions from '@actions/core';
import axios, { AxiosInstance } from 'axios';
import { z } from 'zod';

export const prettyPrint = (o: unknown): string => {
  return JSON.stringify(o, null, 2);
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const zEnvSchema = z.object({
  // GitHub Actions inputs are converted to environment variables prefixed with INPUT_
  // https://docs.github.com/en/actions/creating-actions/metadata-syntax-for-github-actions#inputs
  'INPUT_API-KEY': z.string().nonempty(),
  'INPUT_PROJECT-ID': z.string().nonempty(),
  // Default environment variables during a GitHub Actions run
  // https://docs.github.com/en/actions/learn-github-actions/variables#default-environment-variables
  GITHUB_SHA: z.string().nonempty(),
  GITHUB_EVENT_NAME: z.enum(['pull_request', 'push', 'delete']),
  GITHUB_EVENT_PATH: z.string().nonempty(),
});

const env = zEnvSchema.parse(process.env);

// https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request
const zPullRequestSchema = z.object({
  pull_request: z.object({
    head: z.object({
      ref: z.string().nonempty(),
      sha: z.string().nonempty(),
    }),
  }),
});

// https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
const zPushSchema = z.object({
  ref: z.string().nonempty(),
});

// https://docs.github.com/en/webhooks/webhook-events-and-payloads#delete
const zDeleteSchema = z.object({
  ref: z.string().nonempty(),
});

const getRef = (): string => {
  // GitHub actions are triggered by webhooks and the webhook payload is
  // saved to a JSON file at GITHUB_EVENT_PATH
  const rawEvent = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));

  switch (env.GITHUB_EVENT_NAME) {
    case 'pull_request':
      return `refs/heads/${
        zPullRequestSchema.parse(rawEvent).pull_request.head.ref
      }`;
    case 'delete':
      return `refs/heads/${zDeleteSchema.parse(rawEvent).ref}`;
    case 'push':
      return zPushSchema.parse(rawEvent).ref;
  }
};

const getRefName = (): string => {
  const ref = getRef();

  if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) {
    return ref.split('/').slice(2).join('/');
  }

  const errorMessage = `Ref '${ref}' is not a branch or tag.`;
  actions.error(errorMessage);
  throw new Error(errorMessage);
};

export const makeNeonBranchNamePrefix = (): string => {
  return `${getRefName()}-`;
};

export const makeNeonBranchName = (): string => {
  return makeNeonBranchNamePrefix() + env.GITHUB_SHA.slice(0, 7);
};

// Schema of Neon branches
// https://api-docs.neon.tech/reference/getprojectbranch
const zBranchSchema = z.object({
  id: z.string().nonempty(),
  project_id: z.string().nonempty(),
  parent_id: z.string().nonempty().optional(),
  name: z.string().nonempty(),
  current_state: z.enum(['init', 'ready']),
});

export type Branch = z.infer<typeof zBranchSchema>;

// Schema of Neon endpoints
// https://api-docs.neon.tech/reference/getprojectendpoint
const zEndpointSchema = z.object({
  id: z.string().nonempty(),
  host: z.string().nonempty(),
  current_state: z.enum(['init', 'active', 'idle']),
});

export type Endpoint = z.infer<typeof zEndpointSchema>;

export class NeonSDK {
  private readonly baseUrl: string = 'https://console.neon.tech';
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: `${this.baseUrl}/api/v2/projects/${env['INPUT_PROJECT-ID']}`,
      headers: {
        Authorization: `Bearer ${env['INPUT_API-KEY']}`,
      },
    });
  }

  private async retryFn<T>(args: {
    fn: () => Promise<T>;
    retries: number;
    delaySeconds: number;
  }): Promise<T> {
    try {
      return await args.fn();
    } catch (error: unknown) {
      if (args.retries === 0) {
        actions.error(`Timed out retrying:\n${prettyPrint(error)}`);
        throw error;
      }

      console.log(
        `Retrying in ${args.delaySeconds} seconds (${args.retries} retries left)`,
      );

      await sleep(args.delaySeconds * 1000);

      return this.retryFn({
        fn: args.fn,
        retries: args.retries - 1,
        delaySeconds: args.delaySeconds * 2,
      });
    }
  }

  public makeBranchHtmlUrl(branchId: string): string {
    return `${this.baseUrl}/app/projects/${env['INPUT_PROJECT-ID']}/branches/${branchId}`;
  }

  public async getBranch(branchId: string): Promise<Branch> {
    const {
      data: { branch: branchRaw },
    } = await this.client.get(`/branches/${branchId}`);

    return zBranchSchema.parse(branchRaw);
  }

  public async getBranchByName(
    branchName: string,
  ): Promise<Branch | undefined> {
    const branches = await this.getBranches();
    return branches.find((branch) => branch.name === branchName);
  }

  public async createBranch(args: {
    name: string;
    endpointType: 'read_write' | 'read_only';
    endpointSuspendTimeoutSeconds: number;
    endpointAutoscalingLimitMinCu: number;
    endpointAutoscalingLimitMaxCu: number;
  }): Promise<{ branch: Branch; endpoints: Endpoint[] }> {
    const fn = async (): Promise<{ branch: Branch; endpoints: Endpoint[] }> => {
      const { data } = await this.client.post('/branches', {
        branch: {
          name: args.name,
        },
        endpoints: [
          {
            type: args.endpointType,
            suspend_timeout_seconds: args.endpointSuspendTimeoutSeconds,
            autoscaling_limit_min_cu: args.endpointAutoscalingLimitMinCu,
            autoscaling_limit_max_cu: args.endpointAutoscalingLimitMaxCu,
          },
        ],
      });

      return {
        branch: zBranchSchema.parse(data.branch),
        endpoints: z.array(zEndpointSchema).parse(data.endpoints),
      };
    };

    return this.retryFn<{ branch: Branch; endpoints: Endpoint[] }>({
      fn,
      retries: 5,
      delaySeconds: 1,
    });
  }

  public async deleteBranch(branchId: string): Promise<void> {
    await this.client.delete(`/branches/${branchId}`);
  }

  public async getEndpoint(endpointId: string): Promise<Endpoint> {
    const {
      data: { endpoint: endpointRaw },
    } = await this.client.get(`/endpoints/${endpointId}`);

    return zEndpointSchema.parse(endpointRaw);
  }

  public async getBranches(): Promise<Branch[]> {
    const {
      data: { branches: branchesRaw },
    } = await this.client.get('/branches');

    const branches = z.array(zBranchSchema).parse(branchesRaw);

    // Filter out branches without a parent, since the branches
    // we care about are children of the main branch.
    return branches.filter((branch) => !!branch.parent_id);
  }

  public async getEndpointForBranch(branchId: string): Promise<Endpoint> {
    const {
      data: { endpoints: endpointsRaw },
    } = await this.client.get(`/branches/${branchId}/endpoints`);
    const endpoints = z.array(zEndpointSchema).parse(endpointsRaw);
    const endpoint = endpoints[0];
    if (!endpoint) {
      throw new Error(`No endpoint found for branch ${branchId}`);
    }
    return endpoint;
  }

  public async waitForBranchToBeReady(branchId: string): Promise<void> {
    console.log(`Wating for branch ${branchId} to be ready`);
    const fn = async () => {
      const branch = await this.getBranch(branchId);
      if (branch.current_state === 'ready') {
        console.log(`Branch ${branchId} is ready!`);
        return;
      }
      throw new Error(`Branch ${branchId} is not ready yet.`);
    };

    return this.retryFn<void>({
      fn,
      retries: 5,
      delaySeconds: 0.25,
    });
  }

  public async waitForEndpointToBeReady(endpointId: string): Promise<void> {
    console.log(`Wating for endpoint ${endpointId} to be ready`);

    // Start the endpoint
    try {
      await this.client.post(`/endpoints/${endpointId}/start`);
    } catch {
      // The /start endpoint throws an error if the endpoint is already started
      // so we can ignore it and rely on check below to see if it's started
    }

    const fn = async () => {
      const endpoint = await this.getEndpoint(endpointId);
      if (endpoint.current_state === 'active') {
        console.log(`Endpoint ${endpointId} is ready!`);
        return;
      }
      throw new Error(`Endpoint ${endpointId} is not ready yet.`);
    };

    return this.retryFn<void>({
      fn,
      retries: 5,
      delaySeconds: 0.25,
    });
  }
}
