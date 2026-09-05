# `ai-sdlc doctor` — project config-health audit

**Status:** Active (AISDLC-578, extends the attestation-governance check shipped in AISDLC-560)
**Audience:** AI-SDLC operators and adopters auditing an installed project's configuration.
**Companion command:** `/ai-sdlc doctor` (slash command wrapper)
**Code surface:** `orchestrator/src/cli/commands/doctor.ts` (command + entry point), `orchestrator/src/cli/commands/doctor-checks.ts` (check registry)

---

## TL;DR

```bash
ai-sdlc doctor              # read-only audit, human-readable table
ai-sdlc doctor --format json   # machine-readable result set
ai-sdlc doctor --fix        # apply the safe/mechanical auto-fixes, then re-report
ai-sdlc doctor --strict     # exit non-zero on warn severity too (default: only fail exits non-zero)
```

`ai-sdlc init` scaffolds a correct project once. Nothing re-validates the
setup afterward — config drifts, runtime/plugin versions lag, files get
hand-edited, and some failure modes (a missing/malformed
`.ai-sdlc/agent-role.yaml`, for example) fail silently. `ai-sdlc doctor` is
the "go looking for drift" command: it audits the live project against
what a compliant install should look like and reports pass/warn/fail per
check with a one-line remediation.

**This is a LOCAL, read-by-default audit.** No network calls except the
ones individual checks make deliberately (fetching the plugin marketplace
version, resolving an npm registry pin) — never a phone-home / telemetry
call. Upstream reporting (an opt-in, anonymized "file this as a GitHub
issue" flow) is a separate, not-yet-built RFC that extends RFC-0025; this
command's typed result shape (`anonymizableEvidence` per finding) is the
extension seam for that RFC, not an implementation of it.

## Check registry

Each check is an independent, pure function of `{ projectDir, adapters }`
that returns one or more typed findings:

```ts
interface DoctorCheckResult {
  id: string;
  severity: 'pass' | 'warn' | 'fail';
  title: string;
  remediation?: string;
  anonymizableEvidence?: Record<string, unknown>;
}
```

Checks currently implemented (see `DOCTOR_CHECKS` in `doctor-checks.ts`):

| id | What it audits | Reuses |
|---|---|---|
| `plugin-version` | Installed plugin version vs. latest published | `ai-sdlc-plugin/hooks/check-plugin-version.js --print` |
| `runtime-deps-pins` | `runtimeDependencies` pins resolve to what's installed; flags `^0.x` caret traps (AISDLC-574) | `ai-sdlc-plugin/scripts/check-stale-runtime-deps.mjs` (AISDLC-580) |
| `manifests-agree` | `plugin.json` and `.claude-plugin/plugin.json` agree on version + pins (AISDLC-558) | — |
| `attestation-governance` | Attestation required-but-unconfigured; branch protection requiring `ai-sdlc/attestation` directly (AISDLC-388 misconfiguration) | `checkAttestationGovernance` (AISDLC-560) |
| `marketplace-catalog-drift` | Marketplace catalog cache lags the source-of-truth version — the `/plugin` "already at latest" false negative | — |
| `npm-dist-tag-reachability` | Every `runtimeDependencies` pin actually resolves on the configured npm registry | — |

**Deferred to a follow-up** (seed catalog items 4, 5, 6, 8, 9, 10 from the
AISDLC-578 task body): JSON-schema validation of `.ai-sdlc/agent-role.yaml`
and `.ai-sdlc/dor-config.yaml` against the existing schemas, a new
`trusted-reviewers.yaml` schema, husky pre-push snippet presence, feature-flag
sanity, and workflow-file-presence diffing against `init-templates.ts`. These
need a JSON-schema validator dependency (`ajv`) added to `orchestrator/`,
which is out of scope for this landing — see the AISDLC-578 PR body for the
explicit follow-up task reference.

### Adding a check

Append a `{ id, description, run, fix? }` object to `DOCTOR_CHECKS` in
`doctor-checks.ts`. `run` must only touch the filesystem/subprocess surface
through the injected `DoctorCheckAdapters` — never `node:fs` /
`node:child_process` directly — so it stays hermetically testable. See the
module docstring in `doctor-checks.ts` for the full contract, including the
rule that a `fix()` must be safe, mechanical, and idempotent.

## `--fix`

Only two checks currently have a mechanical auto-fix:

- `runtime-deps-pins` → re-runs `ai-sdlc-plugin/scripts/install-runtime-deps.sh`.
- `manifests-agree` → copies `plugin.json` (the manifest release-please's
  `extra-files` config bumps directly) over `.claude-plugin/plugin.json`.

`--fix` never touches `.ai-sdlc/**` content a check didn't itself flag, and
never force-anything. Every fix is idempotent — running `--fix` twice in a
row is a no-op the second time.

## Exit code contract

- Any `fail`-severity result → exit 1.
- `warn`-severity results alone → exit 0, unless `--strict` is passed.
- `pass` only → exit 0.

## Plugin-install resolution

Several checks need to locate the installed `ai-sdlc-plugin` package tree
(the directory containing `plugin.json`, `.claude-plugin/plugin.json`, and
`hooks/`). `resolvePluginDir()` tries, in order:

1. `CLAUDE_PLUGIN_ROOT` env var.
2. `<projectDir>/ai-sdlc-plugin` (the ai-sdlc monorepo itself, or a
   `directory`-source marketplace pointed at a checked-out copy).
3. `<projectDir>/node_modules/ai-sdlc-plugin`.
4. A best-effort scan of `~/.claude/plugins/cache/*/ai-sdlc/*` for the
   marketplace-installed cache.

When none of these resolve, plugin-dependent checks degrade to `warn`
("plugin install not found — skipped") rather than `fail` — an
unresolvable plugin location is not itself a misconfiguration.

## Related

- [`docs/operations/quality-gate.md`](quality-gate.md) — the `ai-sdlc/pr-ready` aggregator that `attestation-governance`'s branch-protection sub-check reads.
- AISDLC-560 — the original single-check `ai-sdlc doctor` this task extended into a registry.
- AISDLC-574 / AISDLC-580 — the runtime-dependency pin drift + staleness detection this task's `runtime-deps-pins` check reuses.
