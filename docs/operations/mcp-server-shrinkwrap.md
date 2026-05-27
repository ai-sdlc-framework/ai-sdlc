# MCP Server npm-shrinkwrap.json Runbook

**Decision**: DEC-0002 (2026-05-26) — ship `npm-shrinkwrap.json` for `@ai-sdlc/plugin-mcp-server`
to lock transitive dependency integrity hashes at plugin release time.

**Task**: AISDLC-440

---

## Why this exists

The MCP server is published to npm and installed by adopters via the plugin's runtime install
(`install-runtime-deps.sh`). Without a shrinkwrap, npm resolves transitive deps fresh from
registry semver ranges on every install — a compromised transitive dep ships with no integrity
check (the `event-stream` 2018 incident shape).

`npm-shrinkwrap.json` (the publishable variant of `package-lock.json`) is honored by npm when
installing a package. It pins every transitive dep's `sha512` integrity hash, ensuring
byte-identical installs across all adopter environments.

This composes with AISDLC-439 (DEC-0001 — signed tarball SHA) for defense-in-depth.

---

## File location

```
ai-sdlc-plugin/mcp-server/npm-shrinkwrap.json
```

This file is committed to the repo and published as part of the `@ai-sdlc/plugin-mcp-server`
tarball. npm automatically includes `npm-shrinkwrap.json` in published packages (unlike
`package-lock.json`, which npm excludes from tarballs).

---

## When to regenerate

Regenerate the shrinkwrap whenever any of the following change in
`ai-sdlc-plugin/mcp-server/package.json`:

- A production dependency version is bumped (e.g. `@modelcontextprotocol/sdk` `^1.26.0` → `^1.27.0`)
- A new production dependency is added
- A production dependency is removed

You do NOT need to regenerate for `devDependencies`-only changes.

### Regeneration command (from repo root)

```bash
node ai-sdlc-plugin/mcp-server/scripts/regen-shrinkwrap.mjs
```

Then commit the updated `npm-shrinkwrap.json`:

```bash
git add ai-sdlc-plugin/mcp-server/npm-shrinkwrap.json
git commit -m "chore(plugin): regen mcp-server shrinkwrap for <dep> bump"
```

---

## Renovate / Dependabot transitive bump PRs

When Renovate or Dependabot opens a PR that bumps a transitive dep of the MCP server:

1. **Review the PR normally** — check the bump is safe (no breaking changes, audit notes).
2. **Checkout the branch locally** (or trigger the release workflow to do it automatically).
3. **Regenerate the shrinkwrap**:
   ```bash
   git checkout <branch>
   node ai-sdlc-plugin/mcp-server/scripts/regen-shrinkwrap.mjs
   git add ai-sdlc-plugin/mcp-server/npm-shrinkwrap.json
   git commit -m "chore(plugin): regen mcp-server shrinkwrap after <dep> transitive bump"
   git push
   ```
4. The CI drift gate (`shrinkwrap-drift.test.ts`) will pass once the shrinkwrap is updated.

### Automated regen in the release workflow

`release.yml`'s `publish-npm` job runs `node ai-sdlc-plugin/mcp-server/scripts/regen-shrinkwrap.mjs`
**before** `pnpm -r publish`. This ensures the published tarball always ships a shrinkwrap
that matches the version being released, even if the source-committed shrinkwrap is slightly stale.

The source-committed `npm-shrinkwrap.json` is the authoritative snapshot for the current
development HEAD. The release workflow re-generates it for the exact published version.

---

## CI drift gate

`ai-sdlc-plugin/mcp-server/src/shrinkwrap-drift.test.ts` runs as part of the MCP server's
Vitest suite and fails CI if:

- `npm-shrinkwrap.json` does not exist.
- A production dep from `package.json` is absent from the shrinkwrap's `packages` map.
- Any non-linked package in the shrinkwrap is missing an `integrity` (sha512) hash.
- The `lockfileVersion` is below 2 (integrity hash support requires v2+).

To fix a CI failure:

```bash
node ai-sdlc-plugin/mcp-server/scripts/regen-shrinkwrap.mjs
git add ai-sdlc-plugin/mcp-server/npm-shrinkwrap.json
git commit -m "chore(plugin): regen mcp-server shrinkwrap (drift fix)"
```

---

## workspace:* dep resolution

`@ai-sdlc/pipeline-cli` is declared as `workspace:*` in `package.json` for monorepo
development but resolves to its actual published version in the shrinkwrap. The regen script
automatically reads the sibling package's `version` from `pipeline-cli/package.json` and
substitutes it before running npm.

The root entry (`""`) in the shrinkwrap will show the real version (e.g. `^0.10.0`) rather
than `workspace:*`. This is intentional and matches what adopters see when they install the
published tarball.

---

## Manual verification (AC-5)

To verify npm honors the shrinkwrap on a clean install:

```bash
# Pack the MCP server into a tarball
cd ai-sdlc-plugin/mcp-server
npm pack

# Install into a clean test directory
mkdir /tmp/mcp-install-test && cd /tmp/mcp-install-test
npm install /path/to/ai-sdlc-plugin-mcp-server-0.9.2.tgz

# Verify a transitive dep is pinned to the same SHA as the shrinkwrap
node -e "
  const sw = JSON.parse(require('fs').readFileSync(
    require.resolve('@ai-sdlc/plugin-mcp-server/../../npm-shrinkwrap.json',
    { paths: [process.cwd()] }), 'utf-8'));
  const zod = sw.packages['node_modules/zod'];
  console.log('Shrinkwrap zod integrity:', zod.integrity);
"
# Also check the installed node_modules version:
cat node_modules/@ai-sdlc/plugin-mcp-server/node_modules/zod/package.json | grep '"version"'
```

A matching `integrity` hash confirms npm honored the shrinkwrap.

---

## Threat model note

The shrinkwrap pins transitive dep SHAs at the time the plugin maintainer runs the regen
script. It does NOT protect against:

- A registry attack that replaces a package at an already-resolved version (mitigated by
  npm's content-addressable cache and AISDLC-439 signed tarball).
- A compromise of the regen script itself or the release workflow environment.

For the highest assurance, combine with AISDLC-439 (DEC-0001 tarball signature verification
via the AI-SDLC v6 Merkle attestation envelope).
