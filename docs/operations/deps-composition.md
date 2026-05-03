# Dependency-graph composition feature flag (RFC-0014)

**Audience**: AI-SDLC operators turning on the RFC-0014 composition layer
in their environment. The flag is `AI_SDLC_DEPS_COMPOSITION` and it gates
every Phase 1-4 surface (snapshot writer today; PPA composition, DoR
blast-radius, and Slack/dashboard digests in later phases).

**TL;DR**: it's OFF by default. Set it to `1` (or `true`/`yes`/`on`)
to materialise snapshots, then run `cli-deps inspect` to verify. Phase 5
(corpus-driven soak) eventually flips the default.

| Flag value | Snapshot writer | Future PPA composition | Future DoR blast-radius | Future Slack digest |
| ---------- | --------------- | ---------------------- | ----------------------- | ------------------- |
| unset / `0` / `false` / anything else | no-op | no-op (Phase 2) | no-op (Phase 3) | no-op (Phase 4) |
| `1` / `true` / `yes` / `on` (case-insensitive) | writes JSONL | bumps tied priorities by chain depth | adds "gates N downstream" callout | weekly critical-path section |

---

## When to enable

Enable in dogfood / experimental environments first. The Phase 1
snapshot writer is read-only — flipping the flag on adds a small disk
cost (one JSONL file per pipeline tick under
`$ARTIFACTS_DIR/_deps/`) and changes nothing about dispatch behaviour.

Enable in production once Phase 5's corpus-driven soak confirms downstream
composition behaves as designed (RFC-0014 §11 Phase 5 acceptance:
dispatch correctness > 95% AND no operator override-rate spike). The
hybrid promotion runbook — corpus path or operator-override spot-check —
lives at [`deps-composition-promotion.md`](deps-composition-promotion.md).

## How to enable

Set the environment variable in whatever process runs `cli-deps`:

```bash
# One-shot
AI_SDLC_DEPS_COMPOSITION=1 cli-deps snapshot --tag rolling

# Shell session
export AI_SDLC_DEPS_COMPOSITION=1

# In a CI job (GitHub Actions example)
env:
  AI_SDLC_DEPS_COMPOSITION: '1'
```

Verify the flip by running `cli-deps snapshot --tag rolling` and
confirming `written: true` in the JSON response:

```json
{
  "ok": true,
  "written": true,
  "path": "/abs/.../artifacts/_deps/snapshot.<iso>.rolling.jsonl",
  "tag": "rolling",
  "recordCount": 142,
  "bytes": 28471
}
```

If you see `"written": false` despite setting the flag, the value
probably wasn't truthy by the parser's rules — only `1`, `true`,
`yes`, `on` (any case) count. Anything else is treated as off so a
typo can't accidentally enable composition.

## How to disable / roll back

Unset the variable. The Phase 1 surface has no persistent state beyond
the JSONL files under `$ARTIFACTS_DIR/_deps/`, which are safe to leave
in place — `cli-deps gc` trims rolling-tagged files on its own
schedule (default 30 days), and event-tagged files are designed to
accumulate.

To purge the directory entirely (e.g. for a clean re-soak):

```bash
rm -rf "$ARTIFACTS_DIR/_deps/"
```

This is an unusual operation — the artifact is derived from
`backlog/` and rebuildable on the next `cli-deps snapshot` invocation,
so deletion only loses the historical record, not any source data.

## What changes when the flag is on

### Today (Phase 1)

- `cli-deps snapshot --tag <name>` writes a JSONL artifact to
  `$ARTIFACTS_DIR/_deps/snapshot.<iso>.<tag>.jsonl`.
- `cli-deps gc` and `cli-deps inspect` operate on those artifacts (these
  two commands are NOT gated by the flag — they're useful even after a
  rollback to inspect / clean up files written during a prior trial).

The schema for each record is in
`spec/schemas/deps-snapshot.v1.schema.json`; consumer-facing semantics
are in `pipeline-cli/docs/deps.md`.

### Phase 2 (later)

The PPA dispatcher's priority comparator extends to use
`effectivePriority = priority + maxDownstreamPriority` per RFC-0014
§5.2 — a low-PPA task that unblocks a high-PPA task inherits the
high-PPA's urgency.

### Phase 3 (later)

The DoR clarification comment template gains a blast-radius callout:

> ⚠ This issue currently gates N downstream tasks (AISDLC-X, AISDLC-Y, ...).

For bypass-admitted high-radius tasks the comment switches to a
maintainer-tone FYI variant per RFC-0014 §12 Q5.

### Phase 4 (later)

The Slack weekly digest gains a "Critical Path This Week" section
sourced from the snapshot artifact, sorted by `effectivePriority`.

## Observability

Per pipeline tick (when the flag is on) you should see:

- A new file in `$ARTIFACTS_DIR/_deps/` with timestamp and tag.
- `cli-deps inspect --tag rolling` showing growth over time.
- `cli-deps gc` (run on whatever cadence your scheduler chooses)
  trimming files older than 30d and reporting `bytesFreed`.

If snapshots stop appearing, check (in order):

1. The flag is still set in the process that runs `cli-deps`.
2. `$ARTIFACTS_DIR` resolves to a writable location.
3. The dependency graph itself isn't empty (`cli-deps frontier` returns
   at least one entry, or the cwd has a `backlog/` subtree).

## Cross-references

- RFC: [`spec/rfcs/RFC-0014-dependency-graph-composition.md`](../../spec/rfcs/RFC-0014-dependency-graph-composition.md)
- Snapshot schema: [`spec/schemas/deps-snapshot.v1.schema.json`](../../spec/schemas/deps-snapshot.v1.schema.json)
- CLI surface + record semantics: [`pipeline-cli/docs/deps.md`](../../pipeline-cli/docs/deps.md)
- Foundation graph CLI (AISDLC-117): [`pipeline-cli/docs/dependency-graph.md`](../../pipeline-cli/docs/dependency-graph.md)
