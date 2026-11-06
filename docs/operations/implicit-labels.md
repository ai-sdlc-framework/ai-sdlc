# Implicit outcome labels (RFC-0062 OQ-3, DEC-0387)

`cli-labels extract [--repo-root d] [--out file]` writes JSONL: a `header` line carrying the
combination rule, then one `row` per landed, abandoned or parked task. It records; it never
scores, weights or fits (AISDLC-1210).

Signals per row:

- `outcome`: `landed` (task in `backlog/completed`), `abandoned` (Withdrawn, Superseded, Cancelled),
  `parked` (open task that is blocked or parked).
- `priorityEdit`: direction (`up`, `down`, `none`) of the net change between the first and last
  `priority:` in the task file's git history.
- `queueAge`: days from `created_date` to the first commit setting `status: In Progress`, the median of
  the same priority bucket, and the ratio.
- `holdDecisions`: decision ids whose summary or body names the task and mentions hold or park.

Combination rule: none yet. A downstream rule that turns the signals into a label is a separate task.

## Task class

Assignment rows carry the class from the task file: frontmatter `class:`, else its labels (bug, chore,
feature families), else its referenced code areas (docs-only references are `chore`, any other
`feature`). `cli-labels backfill-class [--dry-run]` rewrites existing `uncategorized` rows and reports
how many stay uncategorized and why.

## Gate clock

`cli-usage scorecard --cells` prints first-pass approval counts per (role, model, class) cell and one
line of Phase 3 gate status (200 per cell).
