# CodeQL merge-blocking ruleset

Repository ruleset `CodeQL high or critical alerts block merge (main)` (id 26749975) targets the default branch with the `code_scanning` rule: tool CodeQL, security alerts threshold `high_or_higher`, alerts threshold `errors`. A pull request that introduces a new high or critical CodeQL alert cannot merge.

The reviewable export is [`.github/rulesets/codeql-main.json`](../../.github/rulesets/codeql-main.json).

## Change it

1. Edit `.github/rulesets/codeql-main.json`.
2. Run `node scripts/apply-codeql-ruleset.mjs` (add `--dry-run` to preview). It finds the ruleset by name, updates it or creates it, then re-exports the applied state to the same file. Re-running is a no-op.
3. Commit the file diff.

The script needs repository Administration write. If the token lacks it, the script prints which permission is missing; that is an operator-only item and there is no alternative path.
