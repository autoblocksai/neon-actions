import * as actions from '@actions/core';
import { z } from 'zod';

import {
  makeNeonBranchName,
  prettyPrint,
  NeonSDK,
  type Endpoint,
} from './util';

const parseEndpointConfigFromInputs = () => {
  const zEndpointConfigSchema = z.object({
    // GitHub Actions inputs are converted to environment variables prefixed with INPUT_
    // https://docs.github.com/en/actions/creating-actions/metadata-syntax-for-github-actions#inputs
    // See https://api-docs.neon.tech/reference/createprojectbranch for descriptions of these params
    'INPUT_ENDPOINT-TYPE': z.enum(['read_write', 'read_only']),
    'INPUT_ENDPOINT-SUSPEND-TIMEOUT-SECONDS': z.coerce
      .number()
      .int()
      .min(-1)
      .max(604800),
    'INPUT_ENDPOINT-AUTOSCALING-LIMIT-MIN-CU': z.coerce.number().min(0.25),
    'INPUT_ENDPOINT-AUTOSCALING-LIMIT-MAX-CU': z.coerce.number().min(0.25),
  });

  return zEndpointConfigSchema.parse(process.env);
};

const getOrCreateBranch = async (
  neon: NeonSDK,
  neonBranchName: string,
): Promise<{ branchId: string; endpoint: Endpoint }> => {
  const existingBranch = await neon.getBranchByName(neonBranchName);
  if (existingBranch) {
    console.log(`Branch '${neonBranchName}' already exists, skipping creation`);
    const endpoint = await neon.getEndpointForBranch(existingBranch.id);
    return {
      branchId: existingBranch.id,
      endpoint,
    };
  } else {
    console.log(`Creating new branch with name '${neonBranchName}'`);
    const config = parseEndpointConfigFromInputs();
    const createdBranch = await neon.createBranch({
      name: neonBranchName,
      endpointType: config['INPUT_ENDPOINT-TYPE'],
      endpointSuspendTimeoutSeconds:
        config['INPUT_ENDPOINT-SUSPEND-TIMEOUT-SECONDS'],
      endpointAutoscalingLimitMinCu:
        config['INPUT_ENDPOINT-AUTOSCALING-LIMIT-MIN-CU'],
      endpointAutoscalingLimitMaxCu:
        config['INPUT_ENDPOINT-AUTOSCALING-LIMIT-MAX-CU'],
    });

    console.log(`Created new branch:`);
    console.log(prettyPrint(createdBranch));

    return {
      branchId: createdBranch.branch.id,
      endpoint: createdBranch.endpoints[0], // There should only be one
    };
  }
};

/**
 * Get the pooled and direct hosts from the endpoint and
 * set them as outputs so they can be used in later steps.
 *
 * In Neon, the pooled hosts are the same as the direct
 * but with the -pooler suffix.
 *
 * Examples:
 *
 * Direct: ep-hard-rice-814315.us-east-1.aws.neon.tech
 * Pooled: ep-hard-rice-814315-pooler.us-east-1.aws.neon.tech
 */
const setOutputsFromEndpoint = (endpoint: Endpoint) => {
  const direct = endpoint.host;
  const pooled = endpoint.host.replace(endpoint.id, `${endpoint.id}-pooler`);
  actions.setOutput('direct-host', direct);
  actions.setOutput('pooled-host', pooled);
};

const main = async () => {
  const neon = new NeonSDK();
  const neonBranchName = makeNeonBranchName();
  const { branchId, endpoint } = await getOrCreateBranch(neon, neonBranchName);

  actions.notice(`Your Neon branch is at ${neon.makeBranchHtmlUrl(branchId)}`);

  await neon.waitForBranchToBeReady(branchId);
  await neon.waitForEndpointToBeReady(endpoint.id);
  setOutputsFromEndpoint(endpoint);
};

main();
