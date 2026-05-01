# Backlog dependency graph (`cli-deps`)

`cli-deps` is the foundation for dependency-aware dispatch in the AI-SDLC
pipeline. It computes the in-memory DAG of every backlog task by reading the
`dependencies:` YAML frontmatter under `backlog/tasks/` (open) and
`backlog/completed/` (closed), and exposes the graph through five
subcommands:

| Subcommand           | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `frontier`           | List tasks ready to dispatch (every dependency in `backlog/completed/`).  |
| `blockers <task-id>` | Walk the transitive dependency closure — open tasks that gate the target. |
| `impact <task-id>`   | Walk the reverse-edge closure — open tasks unblocked when target ships.   |
| `validate`           | Detect cycles + flag dangling references (deps pointing at unknown IDs).  |
| `graph`              | Emit the graph in `mermaid` (default) or `dot` for human inspection.      |
| `preflight <task-id>` | Refuse to start a task whose dependencies aren't all Done.               |

This page is part of AISDLC-117 and is the canonical reference for the model
and the CLI surface.

## The model

```
node       = backlog task (one per .md file in backlog/tasks/+completed/)
edge X→Y   = "X depends on Y"  (Y must be Done before X can start)
status     = open       (file lives in backlog/tasks/)
           | completed  (file lives in backlog/completed/)
frontier   = open nodes whose every outgoing edge targets a completed node
```

The graph is rebuilt fresh on every CLI invocation — it's a few hundred files,
so the cost is negligible (~milliseconds) and there's no cache to invalidate.

### Why "edge X→Y means X depends on Y"

So that the natural reading of the directed graph matches the natural reading
of the YAML:

```yaml
---
id: AISDLC-117
dependencies:
  - AISDLC-100.1   # AISDLC-117 depends on AISDLC-100.1
  - AISDLC-100.3
---
```

→ in the graph, `AISDLC-117 → AISDLC-100.1` and `AISDLC-117 → AISDLC-100.3`.

### What about transitive cases?

If `AISDLC-A → AISDLC-B → AISDLC-C` and only `C` is in `completed/`, then
`B` is on the frontier (its only direct dep is satisfied), but `A` is NOT
on the frontier (its direct dep `B` is still open). Once `B` flips to
completed, `A` joins the frontier next round.

`blockers` walks the transitive forward closure (so for `A` it returns
`[B]` since `C` is already completed). `impact` walks the reverse closure
(so for `C` it returns `[B, A]`).

## CLI usage

The `cli-deps` binary is shipped by the `@ai-sdlc/pipeline-cli` workspace
package. Install the package or use `pnpm --filter @ai-sdlc/pipeline-cli cli-deps ...`.

### `cli-deps frontier`

List the tasks that are ready to dispatch right now.

```bash
$ cli-deps frontier
{
  "ok": true,
  "frontier": [
    {"id": "AISDLC-117", "title": "Compute backlog task dependency graph + ...", "dependencies": []},
    {"id": "AISDLC-103", "title": "Verifier Phase 3 — 30-day soak ...", "dependencies": ["AISDLC-94", "AISDLC-101"]}
  ]
}

$ cli-deps frontier --format table
ID          Title                                         Dependencies (all completed)
----------  --------------------------------------------  --------------------------------
AISDLC-117  Compute backlog task dependency graph + ...   (none)
AISDLC-103  Verifier Phase 3 — 30-day soak ...            AISDLC-94, AISDLC-101
```

The orchestrator dispatch loop in `ai-sdlc-plugin/commands/execute.md` and
`/loop /ai-sdlc execute` consult this list before picking the next candidate
— that's how the AISDLC-104-style duplicate-dispatch bug is caught at source.

### `cli-deps blockers <task-id>`

Walk the transitive dependency closure and list every OPEN task that gates the
target. Useful for "what does X actually need before I can ship it?"

```bash
$ cli-deps blockers AISDLC-100.8
{
  "ok": true,
  "target": "AISDLC-100.8",
  "blockers": [
    {"id": "AISDLC-100.7", "title": "Phase 7 — Documentation ...", "status": "open", "dependencies": [...]}
  ]
}
```

Exits non-zero if the target ID is unknown.

### `cli-deps impact <task-id>`

Walk the reverse-edge closure and list every OPEN task that would unblock
if the target closes. Useful for prioritisation ("if I ship X next, how many
downstream items unblock?").

```bash
$ cli-deps impact AISDLC-100.1
{
  "ok": true,
  "target": "AISDLC-100.1",
  "impact": [
    {"id": "AISDLC-100.2", ...},
    {"id": "AISDLC-100.3", ...},
    {"id": "AISDLC-100.4", ...}
  ]
}
```

### `cli-deps validate`

Detect cycles AND flag dangling references in one pass. Exits 0 on a clean
graph, 1 otherwise. Wire this into CI to refuse merging task files that
introduce a dependency cycle.

```bash
$ cli-deps validate
{"ok": true, "cycles": [], "dangling": []}

$ cli-deps validate
{
  "ok": false,
  "cycles": [["AISDLC-A", "AISDLC-B", "AISDLC-A"]],
  "dangling": [{"source": "AISDLC-Z", "missing": "AISDLC-NEVER-CREATED"}]
}
```

Cycles are reported with the closing edge (so `[A, B, A]` means `A → B → A`).
Equivalent rotations of the same cycle are deduplicated by canonicalising
to the lexicographically smallest member.

### `cli-deps graph`

Emit the graph in `mermaid` (default) or `dot`:

```bash
$ cli-deps graph > docs/backlog-graph.mmd      # mermaid for GitHub markdown rendering
$ cli-deps graph --format dot | dot -Tsvg > docs/backlog-graph.svg   # dot pipeline
```

Open tasks render with a yellow style; completed tasks render with a green
style — so the frontier is visually obvious.

### `cli-deps preflight <task-id>`

The pre-flight check used by `/ai-sdlc execute`. Exits 0 if the task is ready
to dispatch (status `To Do`/`In Progress` AND all dependencies completed),
1 otherwise. The JSON output includes a clear `reason` linking to the
specific blocker(s):

```bash
$ cli-deps preflight AISDLC-100.8
{
  "ok": false,
  "reason": "1 dependency(ies) not yet Done: AISDLC-100.7",
  "blockers": [{"id": "AISDLC-100.7", ...}],
  "dangling": []
}
```

## Integration with `/ai-sdlc execute`

Step 1 of `ai-sdlc-plugin/commands/execute.md` invokes `cli-deps preflight`
right after status validation. If preflight reports `ok: false`, the slash
command body refuses to create the worktree — instead it prints the blocker
list and stops. This is what catches the AISDLC-104-style duplicate-dispatch
class of bug at source: a task whose siblings already shipped (or which is
itself already in `completed/`) cannot be re-dispatched.

For batch dispatch (`/loop /ai-sdlc execute`), the loop driver consults
`cli-deps frontier` to pick the next candidate from the dispatch-ready set
rather than relying on operator instinct.

## What's deliberately out of scope (filed for follow-up)

Per the AISDLC-117 task body, the following are deferred to follow-up tasks
(see RFC-0014 for the composition layer):

- **PPA-aware critical-path scoring** — feed dependency depth into PPA
  priority so a high-PPA task whose blocker is low-PPA auto-bumps the
  blocker's score.
- **DoR blast-radius surfacing** — when an issue is in `Needs Clarification`,
  the DoR comment should surface "this gates N downstream tasks."
- **Slack digest integration** — a weekly "next critical-path items"
  digest entry posted to the visibility channel.
- **Cross-RFC dependency tracking** — declare RFC-N depends on RFC-M and
  surface in the RFC index.

Everything in this document is the bounded foundation: ready-to-dispatch
frontier + transitive blocker/impact queries + cycle/dangling validation,
plus the orchestrator integration that wires it into the dispatch loop.

## Library API

For programmatic consumers, the same functions are exported from
`@ai-sdlc/pipeline-cli/deps`:

```ts
import {
  buildDependencyGraph,
  frontier,
  blockers,
  impact,
  validate,
  preflight,
  renderGraph,
} from '@ai-sdlc/pipeline-cli/deps';

const graph = buildDependencyGraph({ workDir: process.cwd() });
const ready = frontier(graph);
console.log(`${ready.length} tasks ready to dispatch`);
```

See `pipeline-cli/src/deps/dependency-graph.ts` for the full type reference.
