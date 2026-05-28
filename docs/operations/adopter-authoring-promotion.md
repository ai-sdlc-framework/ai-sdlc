# Promoting `AI_SDLC_ADOPTER_AUTHORING` from `experimental` to default-on

**Audience**: AI-SDLC operators (specifically: whoever is dispatching the
final flag-flip PR for RFC-0036). This is the runbook for the final step
of RFC-0036 Phase 11 — flipping the `AI_SDLC_ADOPTER_AUTHORING` env-var
default from `experimental` (opt-in) to `on` so the spec-kit bridge +
adopter RFC scaffold + import-spec CLI become the standard adopter
authoring surface.

**TL;DR**: there are two paths. Both produce the same default-on
end-state. Pick based on whether the adopter-corpus is rich enough for
math.

| Path | When to use | Tooling | Authority |
|---|---|---|---|
| **Corpus path** | ≥N adopters have run `cli-import-spec` successfully in the soak window (threshold below) | adopter-corpus tally + spot-check | Math-rigorous on accuracy rate; operator-judged on cohort breadth |
| **Override path** | Corpus is sparse OR the operator has separate evidence (spot-check of recent imports + dogfood internal usage) the bridge isn't surprising | Eyeball `cli-import-spec` runs against fixture spec-kit corpora | Operator judgment |

The pattern mirrors [`docs/operations/dor-promotion.md`](dor-promotion.md),
[`docs/operations/deps-composition-promotion.md`](deps-composition-promotion.md),
and [`docs/operations/orchestrator-promotion.md`](orchestrator-promotion.md)
— the established RFC-0011 / RFC-0014 / RFC-0015 hybrid-promotion
convention. Read those if you haven't seen the corpus-vs-override
trade-off before; this runbook follows the same shape.

---

## Background: why two paths?

Per maintainer directive 2026-05-01 (RFC-0011 §5.5 originating, reused
by RFC-0014 §11 Phase 5 + RFC-0015 §11 Phase 5 + this RFC §13 Phase 11):
**calendar duration is a side-effect, not a gate**. The promotion
criteria for the adopter-authoring surface are:

- **Import accuracy ≥ 95%** — across adopter `cli-import-spec` runs in
  the soak window, ≥95% produce a backlog task that DoR admits without
  a clarification cycle. The denominator is "adopter import attempts";
  the numerator excludes runs that bounce back as
  `import-blocked-on-dor` (OQ-3 / OQ-10) — that's the surface working
  as intended, not a defect.
- **Adopter cohort breadth ≥ 3 distinct organizations** OR ≥ 10 distinct
  adopter repos. The corpus must reflect more than the framework's own
  dogfood usage. A bridge that "works perfectly" against ONE adopter's
  spec-kit style is overfit; the cohort gate forces breadth before the
  surface becomes default-on.
- **Zero unresolved `Decision: incomplete-spec-detected` /
  `Decision: spec-drift-detected` / `Decision: import-blocked-on-dor`
  escalations in the operator's batch review** — per RFC §14 OQ-1 / OQ-2
  / OQ-10, these Decisions are designed to auto-resolve via the catalog
  (RFC-0035). An unresolved backlog of operator-facing escalations
  means the catalog routing isn't keeping up, and flipping to default-on
  would amplify the queue.
- **Adopter RFC scaffold usage signal ≥ 5 invocations** of
  `ai-sdlc rfc init` (or `/ai-sdlc rfc-init`) across the cohort. The
  scaffold doesn't need to be load-bearing to flip the flag — it just
  needs to demonstrate it isn't unused infrastructure.

Whichever path satisfies the criteria first wins. Until the adopter
corpus accumulates enough data after Phases 1-10 ship for confident
math, the operator may use the override path (eyeball + judgment) so
the promotion isn't gated on calendar time.

The two paths produce the same end-state: the
`AI_SDLC_ADOPTER_AUTHORING` default flips from `experimental` (opt-in)
to `on` in the appropriate config surface (see "The flag flip" below).
The only difference is which evidence justified the flip.

---

## Promotion ladder

The flag transitions through three states. Each transition is
operator-dispatched; nothing auto-promotes.

```
┌─────────────────┐    Phase 1-10 land    ┌─────────────────┐    Phase 11 runbook    ┌─────────────────┐
│  experimental   │ ────────────────────> │   shadow-mode   │ ────────────────────>  │   default-on    │
│  (opt-in)       │                       │  (default-on    │                        │   (no opt-out   │
│                 │                       │   in dogfood;   │                        │    surface for  │
│                 │                       │   opt-in for    │                        │    framework    │
│                 │                       │   adopters)     │                        │    surface;     │
│                 │                       │                 │                        │    opt-OUT env  │
│                 │                       │                 │                        │    for          │
│                 │                       │                 │                        │    adopters)    │
└─────────────────┘                       └─────────────────┘                        └─────────────────┘
```

- **`experimental`** — the state during Phases 1-10. The CLI exists; the
  docs name it; nothing else assumes adopters use it. Adopters set
  `AI_SDLC_ADOPTER_AUTHORING=experimental` (or the standard
  `1`/`true`/`yes`/`on` truthy strings) to opt in.
- **`shadow-mode`** — the bridge is on by default in the dogfood project
  + reference adopters, but the broader adopter init template still
  ships with the flag unset. This intermediate state exists to surface
  any deployment-config drift (e.g. workflows that hard-code
  `AI_SDLC_ADOPTER_AUTHORING=experimental` and would silently break
  on default-on) before the flip cascades.
- **`default-on`** — the flag's parser defaults to ON when unset.
  Adopters who want the legacy "Task altitude only" workflow opt OUT
  via `AI_SDLC_ADOPTER_AUTHORING=off` (or `0`/`false`/`no`).

Shadow-mode is OPTIONAL but recommended for the first cutover. If the
corpus signal is unambiguous and the override path's spot-checks are
clean, the operator may skip shadow-mode and go straight to default-on
— document the decision in the flag-flip PR body either way.

---

## Corpus path (preferred when ≥10 adopter import attempts across ≥3 orgs)

### 1. Collect adopter-corpus signal

Unlike RFC-0014's `cli-deps-corpus` and RFC-0015's
`cli-orchestrator-corpus`, RFC-0036 does NOT ship a dedicated corpus
aggregator binary in v1 — the adopter surface is conversational
(import-spec runs, RFC scaffold invocations, Decision catalog
escalations) rather than per-tick observable. The corpus is assembled
manually from three sources:

**Source 1: dogfood + reference-adopter import logs.**

```bash
# The dogfood project + any reference adopters log import attempts to
# `$ARTIFACTS_DIR/_import-spec/imports.jsonl` (one line per
# `cli-import-spec` invocation). The conventional location is
# `./artifacts/_import-spec/imports.jsonl` when ARTIFACTS_DIR isn't set.
cat ./artifacts/_import-spec/imports.jsonl | jq -s 'length' \
  # total attempts in the corpus
cat ./artifacts/_import-spec/imports.jsonl | jq -s '[.[] | select(.outcome=="admitted")] | length' \
  # admitted count = the numerator for accuracy rate
cat ./artifacts/_import-spec/imports.jsonl | jq -r '[.[] | .adopter] | unique | length' \
  # distinct adopter cohort breadth
```

**Source 2: Decision Catalog escalations from the adopter surface.**

```bash
# Filter the catalog for the three RFC-0036-originating Decision types.
node pipeline-cli/bin/cli-decisions.mjs list --status open --format json \
  | jq '[.[] | select(.scope=="adopter-authoring")] | length'
```

A non-zero open-Decisions count on the adopter-authoring scope means
the catalog has unresolved operator-facing escalations — the corpus
gate fails until they're resolved (route through the appropriate
actor; the operator's batch-review cadence is documented in
[RFC-0035 §6](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md)).

**Source 3: adopter RFC scaffold invocation signal.**

```bash
# `ai-sdlc rfc init` writes a marker to `<adopter-repo>/rfcs/.scaffold-log`
# when it runs (one line per invocation). Tally across the cohort:
find ../*-adopter*/rfcs -name '.scaffold-log' -exec cat {} + 2>/dev/null \
  | wc -l
```

If you don't have ≥5 invocations across the cohort, the RFC scaffold
signal is too weak to promote — adopters aren't using it. Either
extend the soak window or fall back to the override path with a note
that scaffold uptake is below threshold (the flip can still proceed
on the import-spec criteria; the scaffold is an independent surface).

### 2. Evaluate against the thresholds

| Metric | Threshold | Path-A source | Path-B fallback (spot-check) |
|---|---|---|---|
| Adopter attempts | ≥ 10 | `imports.jsonl` line count | Eyeball recent invocations |
| Distinct adopters | ≥ 3 | `jq` over `imports.jsonl` `adopter` field | Knowledge of who's running it |
| Import accuracy | ≥ 95% | `admitted / total` from `imports.jsonl` | Recent admits vs rejects |
| Open `adopter-authoring` Decisions | = 0 | `cli-decisions list --status open` | UI scan of the catalog |
| RFC scaffold invocations | ≥ 5 | `.scaffold-log` tally | Operator memory |

A **`safe-to-promote`** recommendation requires ALL five metrics to
meet threshold. A **`continue-soak`** recommendation names the failing
metric. **`insufficient-data`** = corpus has < 10 attempts; fall back to
the override path.

### 3. Dispatch the flag flip

Once the corpus signals `safe-to-promote`, follow "The flag flip"
section below. Include the metrics tally + the source `jq` queries in
the PR body as the audit trail.

---

## Override path (when corpus is sparse but signal is clearly fine)

Use this when:

- The corpus tally returns `insufficient-data` (< 10 import attempts
  OR < 3 distinct adopters), AND
- The operator has separate evidence the bridge isn't surprising —
  e.g. they've personally run `cli-import-spec` against the dogfood
  spec-kit fixtures + 1-2 reference adopter spec-kit projects and the
  resulting tasks look reasonable.

### Steps

1. **Spot-check `cli-import-spec` against fixture spec-kit corpora.**

   The repo ships fixture spec-kit projects under
   `pipeline-cli/src/import-spec/__fixtures__/` (or under
   `test-fixtures/spec-kit-projects/` depending on layout). Run the
   import against each and read the generated backlog task body
   carefully:

   ```bash
   # Run import against the canonical fixture
   node pipeline-cli/bin/cli-import-spec.mjs \
     --from pipeline-cli/src/import-spec/__fixtures__/simple-spec \
     --dry-run --format json | jq .

   # Inspect a real adopter's spec-kit project (read-only, no commits)
   node pipeline-cli/bin/cli-import-spec.mjs \
     --from ../some-adopter-repo \
     --dry-run --format json | jq .
   ```

   - Does each `tasks.md` row map to a backlog task with the
     `specRef:` frontmatter pointing back at the upstream artifact?
     (Good — the bridge is preserving the contract.)
   - Does the generated task pass the DoR rubric on the first try?
     (Good — accuracy is meeting the bar.)
   - Are any rows producing `import-blocked-on-dor` Decisions? That's
     working as intended (OQ-10 strict default) — count them as
     "correctly rejected upstream", NOT as accuracy failures.

2. **Spot-check the Decision Catalog for adopter-authoring scope.**

   ```bash
   node pipeline-cli/bin/cli-decisions.mjs list --scope adopter-authoring --format table
   ```

   - Recent `Decision: incomplete-spec-detected` entries that
     auto-resolved are GOOD signal — the catalog is doing its job per
     OQ-1.
   - Recent `Decision: spec-drift-detected` entries that
     auto-resolved are GOOD signal per OQ-2.
   - Open Decisions older than the operator's batch-review cadence
     (default: weekly) are a YELLOW flag — resolve them before
     flipping. The default-on flip will amplify catalog volume; if the
     catalog is backlogged at `experimental` volume, the amplified
     volume will overwhelm.

3. **Spot-check the adopter RFC scaffold invocation.**

   ```bash
   # Run the scaffold against a throwaway tmpdir to confirm it works
   tmpdir=$(mktemp -d)
   (cd "$tmpdir" && git init -q && \
    node /Users/$USER/path-to/ai-sdlc/pipeline-cli/bin/cli-rfc.mjs init \
      multi-tenancy --template framework-rfc)
   cat "$tmpdir/rfcs/RFC-multi-tenancy.md" | head -50
   ```

   - Does the scaffold land in `rfcs/` (the OQ-4 default) without
     manual intervention?
   - Does the template body match the adopter-facing version (no
     internal `lifecycle:` frontmatter, no `requiresDocs` gating)?

4. **Document the decision.** When dispatching the flag-flip PR,
   include a short note in the PR body explaining:

   - Which path was used (corpus or override)
   - The evidence the operator looked at (fixture paths, decision IDs,
     `.scaffold-log` tallies)
   - Whether shadow-mode is being used as an intermediate step or
     skipped

   The override path is the operator's call to make, but the audit
   trail is mandatory.

5. **Dispatch the flag flip** the same way as the corpus path. The
   flip is identical — the only difference is which evidence justified
   it.

---

## Adopter-facing example walkthrough

The following walkthrough illustrates what an adopter sees AFTER the
flag flip lands — what flipping default-on actually changes from the
adopter's seat. Use this section as the body of the announcement post
when the flip ships.

### Before the flip (`experimental` state)

An adopter who wants to use the spec-kit bridge has to opt in
explicitly. Their workflow:

```bash
# In .envrc or a wrapper script:
export AI_SDLC_ADOPTER_AUTHORING=experimental

# Then the spec-kit bridge is reachable:
ai-sdlc import-spec --from ./my-spec-kit-project
# Without the env var, the CLI prints a message about how to opt in.
```

The adopter RFC scaffold is also gated on the same env var:

```bash
export AI_SDLC_ADOPTER_AUTHORING=experimental
ai-sdlc rfc init multi-tenancy
# Without the env var, the command prints the opt-in instructions.
```

### After the flip (`default-on` state)

The opt-in env var disappears from the adopter's setup. Both surfaces
work without ceremony:

```bash
# Spec-kit bridge — works without env setup
ai-sdlc import-spec --from ./my-spec-kit-project
# (Or via slash command: /ai-sdlc import-spec --from ./my-spec-kit-project)

# Adopter RFC scaffold — works without env setup
ai-sdlc rfc init multi-tenancy
# Scaffolds rfcs/RFC-multi-tenancy.md per the OQ-4 default location
# (override via `<adopter-repo>/.ai-sdlc/adopter-authoring.yaml`).
```

The adopter who DOESN'T want the bridge can opt OUT explicitly:

```bash
export AI_SDLC_ADOPTER_AUTHORING=off
# The CLI now refuses with a deprecation-style message.
```

This is the same opt-out semantics RFC-0014 + RFC-0015 use post-flip
(see `feature-flag.ts#isOrchestratorEnabled` for the canonical parser
shape). Adopters who run on the framework defaults gain the bridge
without any action.

### What changes in the framework's published docs

- `docs/tutorials/10-spec-kit-bridge.md` removes the "set
  `AI_SDLC_ADOPTER_AUTHORING=experimental` first" preamble.
- `docs/concepts/spec-driven.md` no longer prefaces the import-spec
  invocation with the opt-in step.
- `docs/getting-started/README.md` mentions the bridge in the
  first-pass walkthrough rather than the advanced section.
- The `ai-sdlc init` template's example
  `.ai-sdlc/adopter-authoring.yaml` no longer comments out the
  spec-kit bridge section as "opt-in".

---

## The flag flip

The `AI_SDLC_ADOPTER_AUTHORING` default is currently `experimental`
(opt-in). The flag parser lands as part of the flip — there is NO
parser in the pre-flip codebase because Phases 1-10 implemented the
surfaces (`cli-import-spec`, `cli-rfc init`, the config reader, the
DoR-at-import wiring) under the assumption that the surfaces were
opt-in. The flip introduces the parser AND inverts the default in the
same PR.

### Option A — introduce the parser with default-on (single-PR flip)

Add `pipeline-cli/src/adopter-authoring/feature-flag.ts` mirroring the
RFC-0015 parser shape:

```typescript
// pipeline-cli/src/adopter-authoring/feature-flag.ts
export const ADOPTER_AUTHORING_FLAG = 'AI_SDLC_ADOPTER_AUTHORING';

const FALSY = new Set(['off', '0', 'false', 'no', 'disabled']);

export function isAdopterAuthoringEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env[ADOPTER_AUTHORING_FLAG];
  if (!raw) return true; // default-on after RFC-0036 §13 Phase 11 promotion
  return !FALSY.has(raw.trim().toLowerCase());
}
```

Then wire `isAdopterAuthoringEnabled()` at the top of each of:

- `pipeline-cli/src/cli/import-spec.ts` — refuse with the opt-out message when `false`.
- `pipeline-cli/bin/cli-rfc.mjs` `init` subcommand — same refuse-with-message pattern.
- `ai-sdlc-plugin/commands/import-spec.md` — refuse with the same message.

The corresponding `--feature-flag-status` subcommand can be added so
adopters can inspect the current state without running the gated
command:

```bash
node pipeline-cli/bin/cli-import-spec.mjs --feature-flag-status
# enabled (default-on)
# enabled (env=AI_SDLC_ADOPTER_AUTHORING=experimental)
# disabled (env=AI_SDLC_ADOPTER_AUTHORING=off)
```

### Option B — set the env in published adopter templates only

A more conservative flip that DOES introduce the parser (Option A's
parser is non-negotiable to support the off-switch) but defaults to
ON only when the `ai-sdlc init` scaffold writes the new
`adopter-authoring.yaml` entry. Existing adopters whose
`adopter-authoring.yaml` predates the flip continue to need
`AI_SDLC_ADOPTER_AUTHORING=experimental` set.

This is the "shadow-mode" cutover. It exists to surface any
deployment-config drift before the full default-on cascade. Useful when
the corpus signal is borderline and the operator wants a phased rollout.

The corpus-path PR should pick **Option A** (true default-on); the
override path may pick either depending on confidence. Both produce the
same operator UX for newly-init'd adopter repos; Option A reaches
existing adopters without a re-init step.

### Files to update in the flag-flip PR

After the parser lands + the default is ON, update:

- `CLAUDE.md` — add an `AI_SDLC_ADOPTER_AUTHORING` bullet to the
  Feature flags section mirroring the RFC-0014 / RFC-0015 bullet
  shape ("On by default since AISDLC-XXX...").
- `docs/operations/adopter-authoring-promotion.md` (this file) — flip
  the TL;DR table's "use the override path" guidance toward
  "promotion is complete; refer to the post-flip section below".
- `docs/concepts/spec-driven.md` — remove the
  `AI_SDLC_ADOPTER_AUTHORING=experimental` preamble from every code
  example.
- `docs/tutorials/10-spec-kit-bridge.md` — same.
- `ai-sdlc-plugin/commands/import-spec.md` (slash command) — remove
  the opt-in preamble; reference the opt-out env for adopters who
  want to disable.
- `ai-sdlc init` adopter-authoring template — flip the
  `.ai-sdlc/adopter-authoring.yaml` example to uncomment the
  spec-kit bridge section.
- RFC-0036 §13 — check Phase 11 done; bump lifecycle Draft → Ready
  for Review → Signed Off → Implemented per the standard RFC
  lifecycle ladder.
- AISDLC-336 (this task's parent — but Phase 11 IS AISDLC-336;
  this task closes via the standard `(AISDLC-336)` commit subject
  pattern).

---

## What happens after the flip

Once `AI_SDLC_ADOPTER_AUTHORING` is ON by default:

- Adopters who run `ai-sdlc import-spec --from <path>` (or
  `/ai-sdlc import-spec`) get the bridge without setting an env.
- Adopters who run `ai-sdlc rfc init <slug>` get the adopter RFC
  scaffold without setting an env.
- The DoR-at-import gate continues to enforce strict mode per OQ-3 /
  OQ-10 — adopters whose spec-kit `tasks.md` fails DoR get the
  refuse-and-emit-clarification loop per RFC §14 OQ-10.
- The Decision Catalog continues to absorb
  `Decision: incomplete-spec-detected` /
  `Decision: spec-drift-detected` /
  `Decision: import-blocked-on-dor` events per RFC §14 OQ-1 / OQ-2 /
  OQ-10 — operators see them in the next batch review.
- The `<adopter-repo>/.ai-sdlc/adopter-authoring.yaml` per-org
  configuration (RFC §14.1) is unchanged — adopters who customised
  the schema keep their overrides.

If the flip turns out to be premature (import-accuracy regression
spikes after promotion, or a wave of catalog escalations overwhelms
the operator's batch review), revert the parser default (Option A) or
remove the env from the template (Option B) in a single-line PR. The
`imports.jsonl` corpus + catalog state keep accumulating regardless of
mode; the next corpus tally will reflect the regression that justified
the rollback.

### Post-flip monitoring

Watch these three signals for the first ~30 days after the flip:

| Signal | Healthy range | Acquisition |
|---|---|---|
| Adopter import accuracy | ≥ 95% (same threshold as the corpus gate) | `jq` over `imports.jsonl` (weekly) |
| Open `adopter-authoring` Decisions | < 5 (warning); < 10 (alert) | `cli-decisions list --scope adopter-authoring --status open` |
| Adopter opt-out env presence | < 1% of repos | Scan adopter repos for `AI_SDLC_ADOPTER_AUTHORING=off` in env files |

An import-accuracy regression below 95% should trigger a re-soak (NOT
an automatic rollback — investigate the regression first; it may be a
single broken spec-kit fixture, not a systemic surface defect). An
open-Decisions spike should trigger a catalog review session. A
wave of opt-out env presence is the strongest signal something is
wrong and warrants immediate revert.

### Rollback procedure

The flag is designed to be a single-line revert. Rollback is the
mirror of the flip:

```bash
# Option A rollback — re-flip the parser default to OFF (experimental).
git revert <flag-flip-sha>
git push origin HEAD --force-with-lease  # only on a feature branch
```

```bash
# Option B rollback — remove the default-on uncomment from the
# adopter-authoring.yaml template. (No code change; existing repos
# whose env is unset revert to opt-in semantics.)
```

The `imports.jsonl` corpus + Decision Catalog keep flowing through
the rollback — nothing is lost, and the next corpus tally will show
the regression that justified the rollback.

---

## References

- RFC-0036 §13 Phase 11 (this runbook — adopter-authoring promotion)
- RFC-0036 §14 OQ-1 / OQ-2 / OQ-3 / OQ-10 (Decision-routed import strictness)
- RFC-0036 §14.1 (per-org `adopter-authoring.yaml` schema)
- AISDLC-326 (Phase 1 — spec-driven concept doc + altitude rubric)
- AISDLC-327 (Phase 2 — `ai-sdlc rfc init` + adopter RFC template)
- AISDLC-329 (Phase 4 — `cli-import-spec` for spec-kit `tasks.md`)
- AISDLC-330 (Phase 5 — DoR-at-import strict-by-default)
- AISDLC-331 (Phase 6 — `cli-import-spec --reconcile` drift handling)
- AISDLC-332 (Phase 7 — `docs/tutorials/10-spec-kit-bridge.md`)
- AISDLC-333 (Phase 8 — positioning update PR sweep)
- AISDLC-334 (Phase 9 — `ai-sdlc rfc index` Decision Catalog integration)
- AISDLC-335 (Phase 10 — BYO translator adapter docs)
- AISDLC-336 (Phase 11 — this runbook)
- [`docs/operations/dor-promotion.md`](dor-promotion.md) — sister
  promotion runbook for the RFC-0011 DoR `enforce` flip; same
  hybrid-corpus-OR-override structure (original pattern)
- [`docs/operations/deps-composition-promotion.md`](deps-composition-promotion.md)
  — sister promotion runbook for RFC-0014's
  `AI_SDLC_DEPS_COMPOSITION` flip; same hybrid structure
- [`docs/operations/orchestrator-promotion.md`](orchestrator-promotion.md)
  — sister promotion runbook for RFC-0015's
  `AI_SDLC_AUTONOMOUS_ORCHESTRATOR` flip; same hybrid structure
- [RFC-0035](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md)
  §6 — Decision Catalog operator batch-review cadence; the surface
  the adopter-authoring escalations route through
- [`docs/concepts/spec-driven.md`](../concepts/spec-driven.md) —
  three-tier authoring model + altitude rubric; the conceptual frame
  this runbook operationalises
- [`docs/tutorials/10-spec-kit-bridge.md`](../tutorials/10-spec-kit-bridge.md)
  — adopter-facing tutorial for the spec-kit bridge
