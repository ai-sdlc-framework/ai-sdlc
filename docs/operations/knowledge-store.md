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
is absent the built-in default applies. The default trunks are `systems`, `products`,
`customers`, `decisions`, `people`, `process` and `memory` (indexed auto-memory, held at
`scope: protected`).

A store backend may supply the ontology instead (AISDLC-1435), so a shared remote store
holds one ontology for every clone. `KnowledgeStore.ontology?(): Ontology` is optional:
when a backend implements it, validation (`cli-context validate`), `ingest-memory` and the
`cli-context` ingest, promote and human commands use what it returns and ignore
`ontology.yaml`. A backend without it, `files` included, reads `<trackedRoot>/ontology.yaml`
exactly as before: the file replaces the default wholesale, and a malformed file is a
validation error. Every caller resolves the ontology through `storeOntology(store,
trackedRoot)` in `knowledge-store.ts`; nothing else calls `loadOntology`.

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

### Store backend (DEC-0427)

`knowledge.backend` defaults to `files`, the only backend open source ships. Another name
needs `knowledge.backendModule`: a bare npm package specifier, resolved from the project
root, whose package exports `registerKnowledgeBackends(registry)` and calls
`registry.registerKnowledgeBackend(name, factory)`. Relative or absolute paths and URL
specifiers are refused. Selection fails closed: an unregistered backend or a module that
fails to load raises `KnowledgeBackendError`, `cli-context` exits 1, and the surfacing hook
surfaces nothing and prints the error to stderr. It never falls back to files.

A registered factory has the signature `(cfg, { projectRoot, options }) => KnowledgeStore`
(`KnowledgeBackendFactory`, AISDLC-1432). `cfg` holds the roots and the backend selection;
`projectRoot` is the project the store is opened for (always set: every
`openKnowledgeStore` call passes it, so relative roots and `backendModule` never resolve
against the working directory); `options` is the raw `knowledge.<backend>` block of
`.ai-sdlc/context.yaml`, or `null` when the block is absent. For `backend: remote` that is
the `knowledge.remote` mapping:

```yaml
knowledge:
  backend: remote
  backendModule: '@example/knowledge-remote'
  remote:
    endpoint: https://kb.example.com
    credentialsRef: env:KB_TOKEN
```

`loadKnowledgeConfig` carries the block through unvalidated as `backendOptions` (unknown
keys and nested values arrive unchanged); the backend owns validation. The built-in
`files` backend takes no options and ignores a `knowledge.files` block.

Release note (0.45.0 factory type): the registered backend factory is now
`(cfg, { projectRoot, options })`; replace `(cfg, projectRoot)`.

The module is loaded with `require`, so an ES-module backend package (`"type": "module"`)
relies on `require(esm)`, which runs without a flag from Node 22.12.0. `pipeline-cli`
declares `engines.node` `>=22.12.0` for that reason (AISDLC-1427); on older Node an
ES-module backend fails closed with `KnowledgeBackendError ... failed to load`. A CommonJS
backend loads on any supported Node.

#### Local paths (AISDLC-1433)

A backend that keeps content on disk (a replica or cache) declares where with the optional
`KnowledgeStore.localPaths(): string[]`: project-relative files or directories. The push
gate holds each to the protected-root rules: `cli-context check-scope` fails when a declared
path is not git-ignored or has tracked files, and with `--rev` when a pushed commit adds a
file under it. A path outside the repository is skipped (it cannot be committed). If
`localPaths()` throws, the gate fails closed. The `files` backend declares none; its roots
are already checked, so a project on `files` sees no new finding.

`cli-context check-backend [--format json]` reports whether `knowledge.backendModule`
resolves, the factory opens, and each declared path is git-ignored; it exits 1 on any of
those failures. The `knowledge-backend` check of `ai-sdlc doctor` runs it and maps the report:
fail when the module does not resolve, the factory does not open, or a path is not
git-ignored; warn when a non-files backend declares zero paths; pass otherwise and for
`files` ([doctor.md](doctor.md)). `localPaths()` changes no write signature.

### Named writes (AISDLC-1455, DEC-0443)

`KnowledgeStore` writes are two async named operations; reads (`get`, `list`, `listRaw`)
stay synchronous. A server backend can then authorize and audit each write by its kind
instead of receiving an opaque edit function.

- `create({ fields, body }, { scope, path?, principal })` creates an entry. It is rejected
  when the location already holds one; a source re-ingest uses `write(id, { kind: 'reingest' })`.
- `write(id, { kind, fields, principal, body? }, { scope? })` applies one named operation.

`WriteKind` is a closed union (`WRITE_KINDS`); adding a kind is an interface change:

| Kind | `fields` | Log event |
|---|---|---|
| `confirm` | patch (confidence, observed); may be empty | `confirmed` |
| `correct` | patch (value, contentHash, observed) | `corrected` |
| `supersede` | the full fields of the NEW entry | `superseded` |
| `promote` | must carry `authority` (the target) and `proof` | `promoted` |
| `reobserve` | patch (confidence, observed) | `reobserved` |
| `refute` | patch (normally `authority: inferred`) | `refuted` |
| `reingest` | the full fields that replace the entry | `reingested` |
| `excise` | none; removes the entry | `excised` |

`supersede` is one call: `write(oldId, { kind: 'supersede', fields: <new entry fields> })`
creates the new entry (with `supersedes: oldId` and a `supersedes` relation) and marks the
old one `status: superseded`. The result names the new id and path.

Every write returns `WriteResult` `{ id, path, created, status, reason? }`. `status` is
`applied`, `proposed` (queued as a proposal for someone with authority to accept) or
`rejected` (`reason` says why; nothing changed). The `files` backend returns `applied`, or
`rejected` for a missing entry, a `promote` without authority or proof, or any `excise`,
which it does not support.

`promote`, `supersede`, `confirm` and `excise` are never deferred offline: a backend
applies, proposes or rejects them synchronously with the call, never queues them for a later
sync.

Every applied `create` and `write` appends exactly one knowledge-log event naming its kind
and principal, including kinds that change no field (`confirm`). A rejected write changes
nothing and logs nothing. Events record field names, never values; a protected entry's event
carries no value and no hash of one (AISDLC-1424).

`principal` (`human:<email>`, `agent:<session>`, `agent:task:<id>`) is recorded in the
local knowledge log only, and `by` derives from it (`human:` is a human, anything else an
agent). A server backend takes the principal from its own credential and ignores the value
passed in.

`create` and `write` are the only write path; `put` and `update` were removed (AISDLC-1456).
Every caller awaits its result:

- `cli-context confirm`, `correct`, `reobserve`, `refute`, `promote`, `supersede` and
  `capture` print `applied: ...`, `proposed: queued as a proposal`, or `rejected: <reason>`
  on stderr with exit code 1. A proposal is never reported as done.
- `ingest`, `ingest-sections` and `ingest-memory` create a new entry and re-ingest an
  existing one; the summary line adds `N queued as a proposal` and `N rejected`, and any
  rejection exits 1.
- `supersede <old> <new> --value <v>` is one `supersede` write: `<new>` is created from
  `<old>` with the new value and must not exist yet; `<old>` is kept and marked superseded.
- A canonical promotion without `--proof` records `proof: operator`, since every `promote`
  carries a proof. `refute --reason` keeps the reason as the entry's `reverify` note,
  because the log records field names only.
- `capture` of an id that already exists is rejected instead of overwriting it.

## Scaffold

`/ai-sdlc init` (and `ai-sdlc init`, `cli-init`, `doctor --fix`) writes two optional files
from the config manifest (`pipeline-cli/src/config-manifest/manifest.ts`, AISDLC-1408) so
a fresh install shows that the store exists and where its keys go:

- `.ai-sdlc/context.yaml` with every `knowledge.*` and `retrieval.*` key at its built-in
  default. Loading it yields the same config as having no file, so deleting it changes
  nothing.
- `.ai-sdlc/knowledge/README.md`, a short note on the tracked root. Validation skips a
  `README.md` at the top of a root; it is not an entry.

Both are optional: a missing one does not refuse a run or fail `cli-init --check`, and a
re-run never overwrites an existing file. Nothing else changes: reads of a missing root
return no entries, and writes create the folders they need.

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

## Generated records ingest

`node pipeline-cli/bin/cli-context.mjs ingest --source generated --file <path>` writes the
records of a JSON file to the tracked root (AISDLC-1436, the item-11 decision record). It
is not an enterprise-gated feature: it reads only the file the operator names, and is
outside the enterprise gate. `--file` is required with this source.

The file is a JSON array of `{id, trunk, type, value, source, proof}` records, all strings.
Each valid record is written like any other ingest source: re-ingest is idempotent by
`contentHash`, and a changed `value` rewrites the entry with `supersedes`. Entries get
decay `seasonal` and confidence 0.8.

Authority is `specialist` only when `proof` is `allowlisted-command:<id>::<expected>` and
`<id>` is in `knowledge.promotion.commands`; the command is not run at ingest. Any other
proof (a path, a test id, free text, or a command id outside the allowlist) is `inferred`.

A record with a missing or non-string field, an id outside `[a-z0-9._-]`, or fields that
fail entry validation (unknown trunk or type, for example) is reported on stderr with its
index and skipped; the other records are still written and the run does not fail. The
write interface is unchanged: each record is a `create`, or a `reingest` write when the
entry exists.

## Sync contract

A store backend that syncs from a remote source (RFC-0053 amendment of 2026-11-26, the
item-9 decision record) writes the backend's own replica that `list()` reads, then calls
`rebuildIndex` (`pipeline-cli/src/knowledge/retrieval/service.ts`). Nothing but rebuild
writes the index; the index stays derived, so RFC-0053 OQ-2 is unchanged.

### Sync trigger and status (AISDLC-1459, DEC-0444)

A backend may implement two optional `KnowledgeStore` methods; the `files` backend omits
both:

- `sync(): Promise<{ pulled, pushed }>` refreshes the replica `list()` reads and sends queued
  writes.
- `status(): Promise<{ queued, rejected, lastSyncAt?, lastError? }>` reports writes waiting
  for the remote, writes it refused, and the backend's own last sync.

`cli-context sync` calls `sync()`, then `rebuildIndex`, prints one JSON line
(`{"supported":true,"at":...,"ok":true,"pulled":N,"pushed":N,"indexed":N}`) and records the
same outcome in `.ai-sdlc/state/knowledge-sync.json` (git-ignored runtime state). A sync or
rebuild error is recorded as `ok: false` with `error` and the command exits 1.
`cli-context status` prints `status()` merged with that stamp: `queued`, `rejected`,
`lastSyncAt` and `lastError` (the stamp's time and error win when a `cli-context sync` ran)
plus the raw stamp as `lastSync`. A `status()` that throws prints
`{"ok":false,"supported":true,"error":...}` and exits 1. On a backend without the method,
either command prints `{"ok":true,"supported":false}` and exits 0.

### Session-start sync (AISDLC-1460, DEC-0444)

The `context-surface.sh sessionStart` hook runs the sync at session start only, never on
every stop: a write already reaches the server at once, so a sync only refreshes the local
replica, and a per-stop sync would rebuild the whole index after every turn. When
`knowledge.backend` is not `files`, the hook starts `cli-context sync` detached (never
awaited) at most once per interval, debounced by the stamp file
`.ai-sdlc/state/knowledge-sync-launch`, then prints one line from `cli-context status` as the
hook's `systemMessage`: `knowledge sync: queued N, rejected N, last sync <time|never>`, plus
`, last error: <message>` when the last sync failed. The interval is
`knowledge.syncIntervalMinutes` in `.ai-sdlc/context.yaml`, default 15 (a reversible
default):

```yaml
knowledge:
  backend: remote
  syncIntervalMinutes: 15
```

With the `files` backend the hook starts nothing and prints nothing. It fails open: a failing
sync or status never blocks the session; a status failure prints
`knowledge sync: status unavailable` and nothing more.

With a configured API embedder each rebuild re-embeds every entry; there is no embedding
cache. A `contentHash` cache is a follow-up only if measured cost requires it.

## Known gaps

- The agent caps (authority `inferred`, confidence 0.85, `reverify` note) apply only when
  an entry sets `writtenBy: agent`. Promotion of agent entries is a later phase, so an
  agent that omits the field is not capped yet.
