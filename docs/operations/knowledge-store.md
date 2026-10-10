# Knowledge store (RFC-0053)

The knowledge layer holds facts that agents and people need as scored, dated entries
in files. This page covers the entry schema, the two roots, the scope rule and the
checks (AISDLC-773).

## Entry schema

An entry is a markdown file with YAML frontmatter at `<root>/<trunk>/<topic>.md`.

| Field | Meaning |
|---|---|
| `id` | Unique id across both roots |
| `trunk` | One of the ontology trunks; must match the directory |
| `type` | One of the ontology entry types |
| `value` | The fact, as one statement |
| `confidence` | Number from 0 to 1 |
| `authority` | `inferred`, `specialist` or `canonical` |
| `scope` | `internal`, `universal` or `protected` |
| `source` | Where the fact came from (a path, URL or record id) |
| `observed` | Date last observed |
| `decay` | `volatile`, `seasonal`, `durable` or `evergreen` |
| `relations` | List of `{type, target}`; `type` must be an ontology relation |
| `supersedes` | Id of the entry this one replaces (optional) |
| `contentHash` | sha256 hex of `value` |

Agent-written entries add `writtenBy: agent`, and must have `authority: inferred`,
`confidence` at most 0.85 and a `reverify` note. Promotion above `inferred` is done by a
verifier or a human, never by the writer.

## Ontology

`<trackedRoot>/ontology.yaml` declares `trunks`, `entryTypes`, `relations` and
`proofKinds`, the closed vocabulary of proofs a verifier may re-run to promote an entry.
An entry that uses an undeclared trunk, type or relation fails validation. When the file
is absent the built-in default applies.

## Two roots and the scope rule

Scope decides location:

- `internal` and `universal` entries live in the tracked root, `.ai-sdlc/knowledge/`.
  They are reviewed and versioned like any other file.
- `protected` entries (client and data-room material) live in the gitignored root
  `.ai-sdlc/knowledge-protected/`. They never enter the repository or a PR body.

Both roots feed one retrieval index. Configure the roots in `.ai-sdlc/context.yaml`:

```yaml
knowledge:
  trackedRoot: .ai-sdlc/knowledge            # default
  protectedRoot: .ai-sdlc/knowledge-protected # default
  classification:
    dataRoomRoots: [client-data/]            # source paths that mark protected material
    clientIdentifiers: [Acme]                # names that mark protected material
```

## Checks

- `node pipeline-cli/bin/cli-context.mjs validate [--strict]` checks every entry in both
  roots and the ontology. Classification findings (source under a data-room root, or a
  client identifier in an unprotected entry) are warnings; `--strict` makes them errors.
- `scripts/check-knowledge-scope.sh` (also `pnpm knowledge:check`, wired into
  `.husky/pre-push`) delegates to `cli-context check-scope`, which uses the real
  frontmatter parser and the roots configured in `.ai-sdlc/context.yaml`. It fails when a
  `protected` entry sits in the configured tracked root, or the configured protected root
  has tracked files or is not git-ignored. Under the pre-push hook it also reads git's
  push ranges from stdin and scans every pushed commit (`--rev <sha> --rev ^<remote-sha>`;
  a new branch scans back to the merge-base with `origin/main`), so an entry added in one
  commit and removed in a later one is still caught, and any file committed under the
  protected root fails even if it is gone from HEAD. If `pipeline-cli/dist` is not built it skips
  with a message outside CI and fails in CI (`CI` set).
- `scripts/check-pr-body-protected.sh <body-file>` (or
  `cli-context check-pr-body --body-file <file>`) fails when a PR body cites a protected
  entry id or the configured protected root path. The pre-push hook runs it when
  `AI_SDLC_PR_BODY_FILE` points at the body. Step 11 (PR creation) should export
  `AI_SDLC_PR_BODY_FILE` to enable this check; until it does, the check runs only when a
  pusher sets the variable.

## Known gaps

- The agent caps (authority `inferred`, confidence 0.85, `reverify` note) apply only when
  an entry sets `writtenBy: agent`. Promotion of agent entries is a later phase, so an
  agent that omits the field is not capped yet.
