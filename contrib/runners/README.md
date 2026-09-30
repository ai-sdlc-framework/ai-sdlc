# Community Runners

Community-contributed **agent runners** — standalone scripts that dispatch a
single issue to a coding-agent runtime, collect the resulting diff via git,
and commit it. These sit alongside [`adapters/`](adapters/) but target a
different extension point: the *dispatch* contract, not the framework's
typed infrastructure interfaces.

| Runner | Runtime | Status |
| --- | --- | --- |
| [OpenCode](opencode/) | opencode v2 CLI (`run --standalone --format json`) | Shipped (alpha) |

## The dispatch contract

A runner is a standalone executable — no build step, no dependency on the
orchestrator package — invoked as:

```
<runner> --workdir <path> --issue <id> --title <text> [options]
```

A runner MUST:

- emit exactly **ONE JSON object on stdout** — the result
  (`{ success, sessionID?, filesChanged, summary, error?, commitSha?,
  tokenUsage?, attempts }`);
- write all diagnostics to **stderr** (never stdout);
- exit `0` on success, `1` on failure;
- isolate itself from any long-lived background service of the underlying
  runtime (OpenCode: always `--standalone` — see
  [`docs/operations/opencode-harness.md`](../../docs/operations/opencode-harness.md));
- operate only inside the **pre-provisioned** worktree/branch — never push
  to a remote, never open PRs; it commits locally and reports.

## Distribution

Runners ship as-is: they are dependency-free source files, so no build step
and no `builder-manifest.yaml` entry are required (the manifest's
`adapters:` key covers the typed adapters in [`adapters/`](adapters/), which
follow [`spec/adapters.md`](../../spec/adapters.md)).

## License

Apache-2.0
