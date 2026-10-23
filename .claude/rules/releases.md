---
paths:
  - "CHANGELOG.md"
  - "release-please-config.json"
  - ".release-please-manifest.json"
  - "**/package.json"
---

# Releases

**CHANGELOG.md is managed exclusively by release-please; never edit it** (one rolling `chore: release main` PR; [`docs/operations/release-flow.md`](docs/operations/release-flow.md)). Land the release PR only on explicit operator instruction: `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind release --arm` (drop `--arm` to merge now). Every non-private workspace package needs `publishConfig` (`pnpm lint:publishable`). See [`docs/operations/release-and-plugin-reference.md`](docs/operations/release-and-plugin-reference.md).
