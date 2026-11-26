---
id: AISDLC-1421
title: knowledge.backend key and backend registration seam, with the RFC-0053 amendment (DEC-0427)
status: In Progress
priority: high
labels:
  - pipeline-cli
  - knowledge
  - enterprise
  - rfc
dependencies:
  - AISDLC-1418
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - pipeline-cli/src/knowledge/config.ts
  - pipeline-cli/src/knowledge/retrieval/registry.ts
  - pipeline-cli/src/config-manifest/manifest.ts
---

## Description

**Five-step review (requirements first).**
1. Question: the enterprise RFC-0002 OQ-R6 (ai-sdlc-enterprise, signed off 2026-11-24) puts a backend registration key in open source so that an enterprise package can register a `remote` store. ENT-15 lists it as a pre-condition. The operator ruled on 2026-11-26 (DEC-0427) that RFC-0053 takes this in as a dated amendment. The amendment keeps the OQ-1 and OQ-2 resolutions as the open-source default. It does not reopen them.
2. Delete: nothing to delete. The amendment adds no second open-source implementation.
3. Simplify: one config key, one optional module key and one in-process registry, modelled on `retrieval/registry.ts:5-27`. That registry fails closed and so does this one.
4. Accelerate: none.
5. Automate: none added.

**Design (fixed by DEC-0427; do not vary it).**
- `knowledge.backend` in `.ai-sdlc/context.yaml`. The default is `files`. `loadKnowledgeConfig` (`config.ts:30-64`) reads it into `KnowledgeConfig.backend`.
- `knowledge.backendModule` is an optional **bare npm package specifier**. A relative path, an absolute path, a `file:` or `data:` URL, or any URL scheme is refused with an error naming the key. The specifier resolves only from the project root through `createRequire(<projectRoot>/package.json)`. The module must export `registerKnowledgeBackends(registry)`.
- The registry: `registerKnowledgeBackend(name, factory)` and `openKnowledgeStore(cfg)`, which extends the factory from AISDLC-1418. `files` is built in and cannot be overridden. A name registered twice is an error.
- **Fail closed:** when `backend` is anything but `files` and no module has registered that name, or the module fails to load, `openKnowledgeStore` throws `KnowledgeBackendError` naming the backend and the module. It **never falls back to files silently**. CLI commands exit non-zero with that message. The hook path keeps RFC-0053's fail-open rule (it surfaces no context and blocks nothing) and writes the error to stderr.
- `CONTEXT_YAML_DEFAULT` (`manifest.ts:80-100`) gains a commented `# backend: files` line. Init writes nothing else.

**RFC-0053 amendment (add verbatim, as a new subsection after the OQ-2 resolution, plus a revision-log row).**

> **Amendment (2026-11-26, DEC-0427): a registered store backend.** OQ-1 and OQ-2 stand as the open-source default: the entries on disk are the store and the source of truth, and `files` is the only implementation open source ships. An adopter may set `knowledge.backend` to the name of a backend that an installed package registers through `knowledge.backendModule`; the store of record is then that backend, and the open-source guarantees in OQ-1 (review by pull request, protected content kept on the operator machine) are the registering package's responsibility, not this RFC's. Selection fails closed: an unregistered backend is an error, never a silent fall-back to files. Origin: ai-sdlc-enterprise RFC-0002 OQ-R6 (signed off 2026-11-24). Provisional until Product reviews this amendment.

Revision-log row: `| 2026-11-26 | Amendment: registered store backend (`knowledge.backend`, `knowledge.backendModule`), DEC-0427, from ai-sdlc-enterprise RFC-0002 OQ-R6; OQ-1/OQ-2 unchanged as the open-source default; provisional pending Product review |`

Do not edit the OQ-1 or OQ-2 resolution paragraphs. Do not add a `Resolution:` marker.

**Out of scope.** Any `remote` implementation, the sync replica and the `knowledge.remote` block. Those are enterprise (ENT-15).

## Acceptance Criteria
- [ ] #1 `knowledge.backend` (default `files`) and `knowledge.backendModule` are read by `loadKnowledgeConfig`, and tests cover them: missing key, `files`, and a named backend.
- [ ] #2 A test fixture package registers a backend named `fixture`. `openKnowledgeStore` returns it when `backend: fixture` and `backendModule` names that package.
- [ ] #3 The fail-closed cases each throw `KnowledgeBackendError`, and a test covers each one: an unregistered name, a module that fails to load, a relative path, an absolute path, a URL specifier, overriding `files`, and a duplicate registration. No code path returns the files store when `backend` is not `files`.
- [ ] #4 With `backend: files`, behaviour and on-disk bytes are unchanged, and the AISDLC-1418 golden test still passes.
- [ ] #5 RFC-0053 carries the amendment subsection and the revision-log row verbatim. The OQ-1 and OQ-2 resolution text is unchanged (the `git diff` shows only additions in those sections).
- [ ] #6 `pnpm dark-code:check` passes with no growth in the baseline. `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
