---
name: import-spec
description: Import a spec-kit feature into the backlog. Reads `tasks.md` and writes one backlog task per upstream entry with `specRef:` back-references (RFC-0036 Phase 4 / AISDLC-329).
argument-hint: --from <path-to-spec-kit-feature>
allowed-tools:
  - Read
  - Bash
model: inherit
---

Import a spec-kit feature into the AI-SDLC backlog. The spec-kit `tasks.md`
at `--from <path>` is parsed; one backlog task is created per upstream task
entry, each carrying a `specRef:` frontmatter block pointing back to the
upstream artifact.

## Per RFC-0036 OQ-1 + OQ-11 (resolved 2026-05-16)

- **`tasks.md` only.** No fallback to `spec.md`. Missing `tasks.md` →
  `Decision: incomplete-spec-detected` is opened in the Decision Catalog
  and a clarification task is filed back in the backlog asking the
  operator to run `/speckit.tasks` upstream and re-run the import.
- **Auto-detect schema; refuse unknown.** Unrecognised `tasks.md` layout →
  `Decision: upstream-schema-unknown` is opened + an upgrade-framework
  task is filed asking for parser support.

## Phase scope (Phase 4 of RFC-0036)

- ✓ CLI + slash command
- ✓ `specRef:` back-references on every generated task
- ✗ DoR at import time (Phase 5 / AISDLC-330)
- ✗ Reconcile / drift handling (Phase 6 / AISDLC-331)

## Usage

```bash
node pipeline-cli/bin/cli-import-spec.mjs --from .specify/specs/<feature>/
```

`$ARGUMENTS` is the path. Accepts either the feature directory
(containing `tasks.md`) or the `tasks.md` file directly.

```bash
ARGS="${ARGUMENTS:-}"
if [[ -z "$ARGS" ]]; then
  echo "Usage: /ai-sdlc import-spec --from <path-to-spec-kit-feature>"
  exit 1
fi

# Pass the operator's args straight through. `--from` is the only required
# flag; `--work-dir` defaults to cwd; `--format` defaults to text.
node pipeline-cli/bin/cli-import-spec.mjs $ARGS
```

## Output

- **Imported:** one line per task written, formatted as `IMP-N (upstream T-NNN) → <path>`.
- **Incomplete spec:** the Decision id (DEC-NNNN) + path of the clarification task created in `backlog/tasks/`.
- **Unknown schema:** same, but the clarification task asks for parser support rather than an upstream re-run.

In all three cases the CLI exits 0 — the failure modes are explicitly
non-blocking per RFC-0035 G0. The operator's next triage pass sees the
Decision + clarification task and decides next steps.

## Notes

- The Decision Catalog feature flag (`AI_SDLC_DECISION_CATALOG`) is default-ON; events land in `.ai-sdlc/_decisions/events.jsonl`.
- Generated backlog tasks use the `IMP-N` prefix to avoid collision with `AISDLC-N`. Clarification tasks use `IMPCLARIFY-N`.
- Per-org config: `.ai-sdlc/adopter-authoring.yaml`'s `import.*` keys (see RFC-0036 §14.1). Defaults match the strict-and-non-blocking outcomes documented above.
