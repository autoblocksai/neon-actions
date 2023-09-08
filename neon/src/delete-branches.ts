import { NeonSDK, makeNeonBranchNamePrefix, sleep } from './util';

const main = async () => {
  const neon = new NeonSDK();
  const neonBranchNamePrefix = makeNeonBranchNamePrefix();
  const branches = await neon.getBranches();

  console.log(`Found ${branches.length} branches:`);
  branches.forEach((branch) => {
    console.log(`  ${branch.name} (${branch.id})`);
  });

  const branchesToDelete = branches.filter((branch) =>
    branch.name.startsWith(neonBranchNamePrefix),
  );

  console.log(`Deleting branches with prefix '${neonBranchNamePrefix}':`);
  for (const branch of branchesToDelete) {
    console.log(`  deleting ${branch.name} (${branch.id})`);
    try {
      await neon.deleteBranch(branch.id);
    } catch (error) {
      console.log(`    couldn't delete branch: ${error}`);
    }
    await sleep(1000); // Sleep between deletes to be polite
  }
};

main();
