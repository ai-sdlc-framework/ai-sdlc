# Changesets

This project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and publishing of packages.

## Adding a changeset

When your PR includes changes that should result in a package version bump, run:

```sh
pnpm changeset
```

This will prompt you to:

1. Select the packages that changed
2. Choose a semver bump type (patch / minor / major)
3. Write a summary of the change

A markdown file will be created in `.changeset/` — commit it with your PR.

## When do packages get published?

1. PRs with changesets merge to `main`
2. The release workflow automatically creates (or updates) a **"Version Packages"** PR that accumulates all pending version bumps and CHANGELOG entries
3. When a maintainer merges that PR, the workflow publishes the bumped packages to npm

## Do I always need a changeset?

No. Changes that don't affect published packages (docs, tests, internal tooling, CI config) don't need a changeset. Only add one when your change affects the public API or behaviour of a published package.
