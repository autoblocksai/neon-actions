<p align="center">
  <img src="https://app.autoblocks.ai/images/logo.png" width="400px">
</p>
<p align="center">
  <img src="assets/neon_white.svg#gh-dark-mode-only">
  <img src="assets/neon_white.svg#gh-light-mode-only">
</p>
<p align="center">
  <a href="https://github.com/autoblocksai/actions/actions/workflows/ci.yml">
    <img src="https://github.com/autoblocksai/actions/actions/workflows/ci.yml/badge.svg?branch=main">
  </a>
</p>

# Neon Branching in GitHub Actions

These actions allow you to easily manage [Neon branches](https://neon.tech/docs/introduction/branching) as you make changes in your repository. Usage is as simple as:

```yaml
name: CI
on: push
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: autoblocksai/actions/neon/create-branch@v1
        with:
          api-key: ${{ secrets.NEON_API_KEY }}
          project-id: ${{ vars.NEON_PROJECT_ID }}
```

```yaml
name: Cleanup
on: delete
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: autoblocksai/actions/neon/delete-branches@v1
        with:
          api-key: ${{ secrets.NEON_API_KEY }}
          project-id: ${{ vars.NEON_PROJECT_ID }}
```

## Setup

- Get your Neon API key and add it to your repository as a **secret**
  - [Instructions on creating a Neon API key](https://neon.tech/docs/manage/api-keys)
  - [Instructions on adding repository secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions#creating-secrets-for-a-repository)
- Get your Neon project ID and add it to your repository as a **variable**
  - Go to [your projects](https://console.neon.tech/app/projects) and click on the project you want to set up
  - The project ID will be in the URL, or you can go to the Settings tab and copy it from there
  - [Instructions on adding repository variables](https://docs.github.com/en/actions/learn-github-actions/variables#creating-configuration-variables-for-a-repository)

## How It Works

This project provides two actions:

**`create-branch`**:

This action creates a Neon branch for the current GitHub branch and commit. The Neon branch name will be the GitHub branch name plus the first seven characters of the commit SHA. For example, if you create a branch called `feat/my-feature` and push three commits, the following Neon branches will be created:

- `feat/my-feature-61b5d0a`
- `feat/my-feature-ff2a8ea`
- `feat/my-feature-389823a`

The Neon branch that is created always branches off of your primary Neon branch.

**`delete-branches`** :

This action deletes all Neon branches associated with the deleted GitHub branch. From the example above, when you delete the `feat/my-feature` branch either directly or by merging its pull request (and have your repository set up to automatically delete branches when pull requests are merged), then the three Neon branches will be deleted.

## `create-branch`

### Inputs

| Name                                | Description                                                                                                     | Required | Default      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- | ------------ |
| `api-key`                           | Your Neon API key                                                                                               | Yes      | N/A          |
| `project-id`                        | The ID of the Neon project to create branches in                                                                | Yes      | N/A          |
| `endpoint-type`                     | The [compute endpoint](https://neon.tech/docs/manage/endpoints#create-a-compute-endpoint) type                  | No       | `read_write` |
| `endpoint-autoscaling-limit-min-cu` | The minimum [compute units](https://neon.tech/docs/manage/endpoints#compute-size-and-autoscaling-configuration) | No       | `0.25`       |
| `endpoint-autoscaling-limit-max-cu` | The maximum [compute units](https://neon.tech/docs/manage/endpoints#compute-size-and-autoscaling-configuration) | No       | `0.25`       |
| `endpoint-suspend-timeout-seconds`  | The [auto-suspend timeout](https://neon.tech/docs/manage/endpoints#auto-suspend-configuration) in seconds       | No       | `0`          |

### Outputs

The `create-branch` action outputs two hostnames of the created branch:

#### `direct-host`

This hostname should be used for direct connections. Likely the only use for this host is for running migrations, as Prisma, for example, requires a direct connection to run migrations.

#### `pooled-host`

This hostname should be used for [pooled connections](https://neon.tech/docs/connect/connection-pooling). This is the hostname that should be used for all other connections, like for running smoketests or for connecting
from a web application.

---

Below is an example of how you might want to use these output variables in later steps of your workflow:

```yaml
name: CI

on: push

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v3

      - name: Setup node
        uses: actions/setup-node@v3

      - name: Install dependencies
        run: npm ci

      - name: Create neon branch
        id: neon
        uses: autoblocksai/actions/neon/create-branch@v1
        with:
          api-key: ${{ secrets.NEON_API_KEY }}
          project-id: ${{ vars.NEON_PROJECT_ID }}

      - name: Run prisma migrations
        run: npx prisma migrate deploy
        env:
          DATABASE_URL: postgres://${{ secrets.PG_USERNAME }}:${{ secrets.PG_PASSWORD }}@${{ steps.neon.outputs.direct-host }}:5432/neondb

      - name: Run smoke tests
        run: npm run test:smoke
        env:
          DATABASE_URL: postgres://${{ secrets.PG_USERNAME }}:${{ secrets.PG_PASSWORD }}@${{ steps.neon.outputs.pooled-host }}:5432/neondb
```

## `delete-branches`

This action is meant to be used in a workflow that runs on the `delete` event. It will delete all Neon branches associated with the deleted GitHub branch.

### Inputs

| Name         | Description                                      | Required | Default |
| ------------ | ------------------------------------------------ | -------- | ------- |
| `api-key`    | Your Neon API key                                | Yes      | N/A     |
| `project-id` | The ID of the Neon project to delete branches in | Yes      | N/A     |

```yaml
name: Cleanup

on: delete

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: autoblocksai/actions/neon/delete-branches@v1
        with:
          api-key: ${{ secrets.NEON_API_KEY }}
          project-id: ${{ vars.NEON_PROJECT_ID }}
```

## More Examples

### Running on pull requests

In some cases you might want to only start creating Neon branches once a pull request has been opened. The `create-branch` action also supports the `pull_request` event:

`create-branch`:

```yaml
name: CI

on: pull_request

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: autoblocksai/actions/neon/create-branch@v1
        with:
          api-key: ${{ secrets.NEON_API_KEY }}
          project-id: ${{ vars.NEON_PROJECT_ID }}
```

For cleanup you have a few options. You can use the same workflow as the examples above to clean up the Neon branches when the pull request's branch is deleted, or you can run the cleanup when the pull request is closed. This might be preferable if your repository isn't set up to automatically delete branches when pull requests are merged.

`delete-branches`:

```yaml
name: Cleanup

on:
  pull_request:
    types:
      - closed

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: autoblocksai/actions/neon/delete-branches@v1
        with:
          api-key: ${{ secrets.NEON_API_KEY }}
          project-id: ${{ vars.NEON_PROJECT_ID }}
```

### Only run when a migrations folder has been modified

If you keep all of your migrations in a folder and only want to run the `create-branch` action when that folder has been modified, you have a few options depending on your workflow setup.

If your worfklow isn't a required status check, you can likely just use the `paths` filter. This means it will only run when the given paths have been modified in the commit.

```yaml
name: Test Migrations

on:
  push:
    paths:
      - path/to/migrations/**

jobs:
  test-migrations:
    runs-on: ubuntu-latest
    steps:
      - uses: autoblocksai/actions/neon/create-branch@v1
        with:
          api-key: ${{ secrets.NEON_API_KEY }}
          project-id: ${{ vars.NEON_PROJECT_ID }}

      # Run migrations etc
```

This doesn't work, however, if the workflow you want to add Neon branching to contains required status checks. This is because it will only run if the pull request modifies the files in the `paths` filter.

From [the GitHub docs](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#example-including-paths):

> If a workflow is skipped due to branch filtering, path filtering, or a commit message, then checks associated with that workflow will remain in a "Pending" state. A pull request that requires those checks to be successful will be blocked from merging.

In this case you probably want to use something like [dorny/paths-filter](https://github.com/dorny/paths-filter), which will allow you to gather the changed files in a step and then use those results to determine which subsequent steps to run. [Unfortunately](https://github.com/actions/runner/issues/662), though, you will need to add an `if` statement to each step involving Neon:

```yaml
name: CI

on: push

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v3

      - name: Setup node
        uses: actions/setup-node@v3

      - name: Install dependencies
        run: npm ci

      - uses: dorny/paths-filter@v2
        id: changes
        with:
          filters: |
            migrations:
              - 'path/to/migrations/**'

      - if: steps.changes.outputs.migrations == 'true'
        name: Create neon branch
        id: neon
        uses: autoblocksai/actions/neon/create-branch@v1
        with:
          api-key: ${{ secrets.NEON_API_KEY }}
          project-id: ${{ vars.NEON_PROJECT_ID }}

      - if: steps.changes.outputs.migrations == 'true'
        name: Run prisma migrations
        run: npx prisma migrate deploy
        env:
          DATABASE_URL: postgres://${{ secrets.PG_USERNAME }}:${{ secrets.PG_PASSWORD }}@${{ steps.neon.outputs.direct-host }}:5432/neondb

      - if: steps.changes.outputs.migrations == 'true'
        name: Run smoke tests
        run: npm run test:smoke
        env:
          DATABASE_URL: postgres://${{ secrets.PG_USERNAME }}:${{ secrets.PG_PASSWORD }}@${{ steps.neon.outputs.pooled-host }}:5432/neondb
```
