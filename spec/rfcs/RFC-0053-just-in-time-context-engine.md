---
id: RFC-0053
title: Just-In-Time Context Engine (Decision Context Engine)
status: Approved
lifecycle: Signed Off
author: 'Dominique Legault'
created: 2026-10-09
updated: 2026-10-09
targetSpecVersion: v1alpha1
requires: [RFC-0019, RFC-0035]
assumes: [RFC-0008, RFC-0011, RFC-0029, RFC-0050]
requiresDocs: []
---

# RFC-0053: Just-In-Time Context Engine (Decision Context Engine)

**Status:** Signed Off (2026-10-09). 8 of 8 Open Questions resolved by operator rubric,
2026-10-09: scope-split two roots; local SQLite adapter; inferred-only writes with
verifier or human promotion; tiered prefix (controls fixed, path rules conditional, the
rest just-in-time); layered evaluation corpus with a golden gate; auto-memory indexed as
a trunk in place; data room as a read-only root with captured facts as protected entries;
triggers narrow by role and widened by evidence. Engineering and Operator have signed;
Product and Design are pending.

## Summary

Agents in this repository get their context from five stores and pay for most of it up
front. This RFC proposes a context engine that holds knowledge as scored, dated,
cited entries with typed relations, retrieves a ranked and budgeted slice at the
moment of need, and surfaces that slice at six moments plus a compaction rule: session start, task claim,
every operator message, every tool touch, decision point (the Definition-of-Ready
gate) and explicit query. The knowledge model
is borrowed from the operator's private data-room kit. Retrieval is new: the kit is
files and grep, and this engine adds a hybrid index (keyword, embeddings, relation
traversal) behind one `cli-context query` surface, with an evaluation set so ranking
is measured, not assumed. The engine blocks nothing and is not a governance control.

## Motivation

### Five stores, one cost model

1. **CLAUDE.md.** About 64 KB, injected into every turn of every session and every
   subagent. AISDLC-651.2 measured a developer run at roughly 25k tokens before it
   reads a single project file, and main sessions account for about 60 percent of
   cache-read tokens.
2. **Claude Code auto-memory.** 123 notes, with an index loaded at every session
   start. AISDLC-729 found that nothing ever merges or removes a note.
3. **The code repository.** Always the final authority on behavior, but found by
   search, not by relevance to the task.
4. **Backlog tasks and GitHub issues.** Reachable by id, rarely by meaning.
5. **Institutional knowledge.** Why a decision was made, who knows what, customer and
   system facts. Today this lives in people's heads, old tickets and chat.

Each store grows, and each is pruned by a separate out-of-band process: the memory
dream (AISDLC-729), backlog drift, CLAUDE.md condensing (AISDLC-742). Nothing selects
context by relevance at the moment of need. Sessions pay for everything up front, and
agents guess when the answer sits in a store they did not read. Decisions then get
made mid-task, by whoever is running, instead of before the work starts by whoever
can answer.

### What this costs

- A fixed per-turn prefix (about 14k tokens of CLAUDE.md per subagent start) that is
  mostly irrelevant to any one task.
- Mid-task escalations and wrong guesses that a pre-dispatch lookup would have
  prevented.
- Three hygiene processes that each prune one store and none that spans them.

## Goals

- One knowledge model for facts that agents and people need: value, confidence,
  authority, scope, source, observed date, decay, typed relations.
- Retrieval that returns a ranked slice under an explicit token budget, with
  citations, behind a single command.
- A surfacing protocol that puts the right slice in front of the right actor at the
  right moment, including routing open questions to the person who can answer them.
- A measured result: retrieval precision against an evaluation set, and token savings
  against the RFC-0050 usage ledger.
- A human surface to query, confirm, correct and supersede entries, and to see gaps.

## Non-Goals

- Replacing the code as the source of truth for behavior. Running code outranks every
  written entry.
- Copying content from the data-room kit. The kit is prior art for mechanics only.
- Adopting the kit's startup intake stages, analysis lenses, 35 business artifact
  types, or HTML rendering and publishing.
- Acting as a governance control. The engine informs and routes; it blocks nothing.
- Deciding the open questions below. They are listed for the operator walkthrough.

## Foundation: prior art in the data-room kit

The operator keeps a private, gitignored kit at `forge-data-room-kit/` that models a
client data room as knowledge entries. This RFC cites it as prior art and reuses its
mechanics, not its content.

**Transferred:**

- An entry is a value plus confidence in 0 to 1 (owner-stated at or above 0.9,
  specialist at most 0.92, agent inference at most 0.85, below 0.7 a candidate).
- An authority tier: canonical, then specialist, orchestrator, research, inferred.
  Entries can be promoted and are never demoted.
- A scope: protected, internal, sector, universal.
- A source citation and an observed date.
- A decay half-life (volatile 30 days, seasonal 180 days, durable 2 years, evergreen)
  with freshness = 0.5^(age / half-life). Below 0.3 an entry is stale, and stale
  means a question, not a fact.
- Typed relations: supports, contradicts, supersedes, depends_on.
- Supersede, never delete.
- Running code outranks every written entry.
- A contradiction becomes a Decision Catalog (RFC-0035) item.
- Agent output carries `authority: inferred` and a re-verify note.
- A priority-tiered context load protocol (ALWAYS, HIGH, MEDIUM, LOW; never split a
  section), with effective confidence = confidence x recency weight.
- Coverage scoring as a gap detector: required x 0.6 + enriching x 0.25 + count x 0.15
  maps to blocked, draft or ready.
- Interview rules: lead with what is known, one question per turn, each gap tagged
  owner, research or analysis.

**Left behind:** startup intake stages, analysis lenses, the 35 business artifact
types, HTML rendering and publishing.

**Absent in the kit, added here:** retrieval. The kit is files, headings and grep.
It has no ranking, embeddings or graph traversal, and its typed relations are
declared but never read.

## Design

Three layers.

### A. Knowledge layer

The entry schema above, stored as files under `.ai-sdlc/knowledge/<trunk>/<topic>.md`
(location resolved by OQ-1). Trunks are engineering domains: systems, products, customers,
decisions, people, process. Every entry has a trunk, a type and relations. An ontology
file declares the entry types and the relations allowed between them.

Two roots, one index (OQ-1). Entries with scope `internal` or `universal` live in the
tracked root `.ai-sdlc/knowledge/`. Entries with scope `protected` live in the
gitignored root `.ai-sdlc/knowledge-protected/` (or a sibling path configured per
adopter) and never enter the repository or a PR body. The write path routes on
`scope`, and one retrieval index spans both roots.

Authority and promotion (OQ-3). Agents write at `authority: inferred` only, with a
confidence cap of 0.85 and a `reverify:` note. A framework verifier (code, not a
model) may promote an entry to `specialist` when it re-runs an attached proof from the
closed vocabulary declared in the ontology and the proof holds. `canonical` requires a
human. Promotion, supersession and refutation are events in the knowledge log.

Ingest adapters project what ai-sdlc already structures into entries, so the engine
starts populated and stays current without double entry:

- Decision catalog events (RFC-0035).
- RFCs: frontmatter and Open Question resolutions.
- Review logs and the reviews ledger.
- Orchestrator events.
- Auto-memory notes.
- Backlog tasks.

Auto-memory (OQ-6) is indexed as a `memory` trunk at `scope: protected` without moving
the files: `user` and `feedback` notes map to `specialist` with the operator as source,
`project` and `reference` notes to `inferred`, and the note file is the citation. The
memory folder remains the harness's write target and AISDLC-729's dream remains its
hygiene pass, with a re-ingest after each folder swap.

The data room (OQ-7) is a separate raw root, `knowledge.dataRoomRoot`, indexed
read-only at `scope: protected` with authority from document kind. Writes under it are
denied unless the active task's `permittedExternalPaths` names it. Capture writes
entries, not documents: facts taken from a document become `protected` entries in the
protected root with a citation to the source.

The fixed prefix (OQ-4) holds governance controls rendered from configuration, the role
and task frame, and pointers, under `prefix.maxBytes`. Path-bound rules live in
`.claude/rules/*.md` with `paths:` frontmatter, which the harness loads
deterministically. Explanatory and historical text becomes entries.

Hygiene is part of the layer: supersede instead of delete, staleness by decay,
contradiction detection raised as Decision Catalog items.

### B. Retrieval layer

A hybrid index behind one `cli-context query` surface:

- Keyword search over entry text.
- Embeddings through the RFC-0019 provider adapter.
- Traversal of typed relations (follow `depends_on`, surface `contradicts`, prefer
  the head of a `supersedes` chain).

The result is a ranked slice that fits a stated token budget, each entry with its
citation, effective confidence and freshness. Every response carries entry ids and
content hashes. `cli-context query` takes `--session <id>`, so the session load
ledger (section C) is subtracted inside the query and the caller never has to filter
repeats itself. The default substrate
(OQ-2) is a local SQLite file behind a `RetrievalIndex` adapter: an FTS5 table for
keyword search with BM25 ranking, a vector table fed through the RFC-0019 provider
adapter, and an edges table for typed relations queried with recursive CTEs, fused
with reciprocal rank fusion. The entries on disk stay the source of truth, and
`cli-context index` rebuilds the file from them. An enterprise adapter
(Elasticsearch, a vector store, a graph database) sits behind the same interface.

Ranking is scored against a layered evaluation corpus (OQ-5). A hand-authored golden
set with relevance judgments gates: recall at 5 of at least 0.8 and no regression
beyond 2 points per release. Questions mined from transcripts (untrusted text,
quarantined as evaluator-only data) and synthetic questions generated from entries
report and do not gate. The load ledger's citation rate is the complementary online
signal.

### C. Surfacing protocol

Six moments and a compaction rule:

1. **Session start** (`SessionStart` hook). A budgeted slice rides beside a fixed prefix
   that holds only controls, the role and task frame, and pointers (OQ-4).
2. **Task claim** (`SubagentStart` hook, Step 5 developer prompt). Entries relevant to
   the task's references and body are injected.
3. **Every operator message** (`UserPromptSubmit` hook). The message text is the
   retrieval key. The top entries above a relevance floor, with citations, ride in as
   additional context. This is the mid-conversation surface for long planner sessions.
4. **Every tool touch** (`PreToolUse` and `PostToolUse` hooks). The file path or
   command is the key, for example "you are editing trusted-policy.js; DEC-0038 and
   AISDLC-756 govern it".
5. **Decision point.** The DoR gate (RFC-0011) asks retrieval for open questions and
   contradictions before dispatch and routes them, through RFC-0035, to the person who
   can answer.
6. **Explicit query** (`cli-context query`) by a human or an agent.

**Compaction** (`PreCompact` hook). The plugin does not register this hook today; it
registers SessionStart, SubagentStart, PreToolUse, PostToolUse and Stop. After a
compaction the slice that mattered is gone, so the engine re-runs the session-start
retrieval against the compaction summary. This is where AISDLC-766's continuous
handoff and the engine meet.

All hook-driven moments share one shape. The hook fires and extracts a key. It calls
`cli-context query --budget N --min-score S --session <id>`. It injects the slice as
data with citations, never as instructions. Decay does the pruning: entries that are
retrieved and confirmed get fresher, and entries that never match age out of the slice
without hand pruning.

#### Session load ledger (load once)

The engine keeps a per-session ledger of which entries (by id and content hash) have
already been injected into this session's context, and at which moment. Every
retrieval subtracts the ledger before injecting, so an entry is loaded once per
session unless its content hash changed. When it changed, the new version is injected
and the ledger notes the supersession.

The ledger lives beside the session (for example
`.ai-sdlc/context/sessions/<session-id>.jsonl`; the exact location is an
implementation detail). It is reset on `/clear` and rebuilt from the compaction
summary on `PreCompact`: entries whose text survives the summary stay marked loaded,
and the rest are eligible again. The ledger also records injected token counts per
entry per moment, so the usage ledger (RFC-0050) can attribute context cost.
CLAUDE.md and the memory index count as pre-loaded entries in the ledger, so the
engine never re-injects what the harness already loaded.

#### Role and model profiles

Surfacing is configured per role as a profile in `.ai-sdlc/context-profiles.yaml`
(schema to be fixed in Phase 3). A profile sets which moments are enabled, the
per-moment token budget, the relevance floor, the trunks in scope and the maximum
injections per N turns. Proposed defaults by role:

- **Planner:** every moment on, with the largest budgets, because it reasons across
  RFCs, decisions and history.
- **Operator-dispatch:** session start, task claim and compaction on; per-message and
  per-tool off, because it runs a fixed loop.
- **Executors:** session start and task claim on at small budgets, per-message off,
  per-tool on only for governance-bearing paths. The developer subagent benefits from
  "this file is governed by DEC-n" and little else.
- **Reviewers:** task claim only, because the diff is their context.

Role is the primary key; the model alias is a secondary override, because model
assignment moves under roles. Haiku relays get nothing beyond session start. Compaction
is on wherever session start is. Profiles are configuration, not governance controls: a
smaller profile never removes a hard rule, because every control stays in the fixed
prefix (OQ-4). Defaults change only through a decision record backed by the
cache-versus-JIT report, asymmetric as in RFC-0050 Part B: adding a moment or raising a
budget needs evidence, removing or lowering is automatic (OQ-8).

#### Prompt cache versus just-in-time context

The fixed prefix (CLAUDE.md, memory index, governance block) is paid once per cache
window and then read from cache at a fraction of the price. Everything the engine
injects mid-conversation is new input that is not cached until the next turn. It
invalidates nothing, but it adds to every later turn's cache read. Continuous clearing
(AISDLC-766) and per-task executor contexts (one task per context) shift weight from
the cache layer to just-in-time loading, because each fresh context pays its slice
again.

The engine therefore reports, per session and per role:

- injected tokens by moment;
- the share of injections later cited or acted on (a tool touch on a cited path, a
  decision referencing an entry);
- the cache-read tokens of the same sessions, from the RFC-0050 ledger.

With these the operator can see whether a profile's injections cost more than the
prefix bytes they displaced. A profile change that raises net tokens over a week is
flagged in the usage report. The routing-table mechanism of RFC-0050 Part B is the
model for turning that into evidence-based profile defaults. This RFC does not assume
that just-in-time loading is cheaper. It instruments the trade so the answer is
measured.

### Configuration

`.ai-sdlc/context.yaml` keys (NEW, walkthrough 2026-10-09):

- `knowledge.trackedRoot` (default `.ai-sdlc/knowledge`)
- `knowledge.protectedRoot` (default `.ai-sdlc/knowledge-protected`)
- `retrieval.adapter: sqlite | enterprise` (default `sqlite`)
- `retrieval.indexPath` (default under `.ai-sdlc/`, gitignored)
- `promotion.proofKinds` (subset of the closed vocabulary the ontology declares)
- `evaluation.goldenRecallAt5: 0.8` (NEW, walkthrough 2026-10-09)
- `evaluation.maxRegressionPoints: 2` (NEW, walkthrough 2026-10-09)
- `knowledge.dataRoomRoot` (optional, unset by default; NEW, walkthrough 2026-10-09)
- `prefix.maxBytes: 10240` (NEW, walkthrough 2026-10-09)

`.ai-sdlc/context-profiles.yaml` sketch (NEW, walkthrough 2026-10-09). Role is the
primary key and model alias is secondary. Budgets are tokens per injection.

```yaml
# NEW (walkthrough 2026-10-09)
profiles:
  planner:
    moments: [sessionStart, taskClaim, userPrompt, toolTouch, decisionPoint, compaction]
    budget: { sessionStart: 3000, taskClaim: 3000, userPrompt: 1500, toolTouch: 800, compaction: 3000 }
    minScore: 0.4
    maxInjectionsPerNTurns: { n: 5, max: 3 }
  operator-dispatch:
    moments: [sessionStart, taskClaim, compaction]
  executor:
    moments: [sessionStart, taskClaim, toolTouch]
    budget: { sessionStart: 1000, taskClaim: 1500, toolTouch: 500 }
    toolTouchPaths: governance-bearing   # per-tool only on governance paths
  reviewer:
    moments: [taskClaim]
  relay:                                  # haiku relays
    moments: [sessionStart]
modelOverrides: {}                        # secondary key, by alias
```

### Human surface

Query, confirm, correct and supersede entries. A coverage dashboard presented as a gap
list. External signals (support, CRM, analytics, roadmap) flow into the PPA (RFC-0008)
as inputs. Token savings are measured through the RFC-0050 usage ledger.

## Phases

Phase 1 tasks (AISDLC-773 to AISDLC-777) and phase 2 to 4 tasks (AISDLC-778 to AISDLC-788) are filed.

1. **Knowledge store, ingest adapters, ported capture and hygiene skills.**
2. **Retrieval, `cli-context query`, evaluation set.** Includes the content hash on
   every entry.
3. **Surfacing protocol.** Hook wiring for the six moments, the `PreCompact`
   registration, the session load ledger, the `context-profiles.yaml` schema with the
   role defaults above, and the cache-versus-JIT report. Absorbs AISDLC-651.2 and
   AISDLC-729 as durable mechanisms.
4. **Human surface, coverage dashboard, external signal ingestion into the PPA.**

## Relationships

- **RFC-0019** (requires): the embedding provider adapter that retrieval uses.
- **RFC-0035** (requires): the Decision Catalog that receives contradictions and open
  questions.
- **RFC-0008** (assumes): the PPA that external signals feed.
- **RFC-0011** (assumes): the DoR gate that becomes a decision-point consumer.
- **RFC-0029** (assumes): design contract for adjacent context handling.
- **RFC-0050** (assumes): the usage ledger that measures token savings.
- **AISDLC-651.2, AISDLC-729, AISDLC-742**: the measurement and hygiene work this
  engine would make durable.

## Security and Trust

- Knowledge entries are data, never instructions, in every prompt that carries them.
- Agent-written entries are capped at `inferred` with a re-verify note.
- Governance rules currently in CLAUDE.md are controls. Moving them into a retrieved
  slice is a weakening, so OQ-4 keeps every control in the fixed prefix.
- Data-room content (client documents) is `protected` scope. It never leaves the
  operator machine and never enters a PR body.
- Transcript-mined evaluation questions are untrusted text.

## Velocity Impact

Required by DEC-0048.

- **Expected gain:** a smaller per-turn fixed prefix (today about 14k tokens of
  CLAUDE.md per subagent start) and fewer mid-task escalations, because answers are
  retrieved before work starts.
- **Cost:** index maintenance, and one more store to keep honest. Per-message and
  per-tool retrieval fire often (a 300-turn dispatch loop is 300 queries), so the
  profile defaults keep those moments off for loop roles, and the Stop-hook budget
  rules and the usage ledger see every injection. The load-once ledger bounds repeat
  cost.
- **Gate behavior:** the engine blocks nothing. It is not a governance control, so it
  adds no step to any merge or push path.
- **Measurement:** token savings through the RFC-0050 usage ledger, retrieval precision
  through the evaluation set.

## Open Questions

All 8 Open Questions resolved 2026-10-09 by operator rubric.

**OQ-1 - Where does the store live?**
*Problem:* location decides visibility, review and trust, and data-room content
depends on it.
*Options:* (a) in-repo `.ai-sdlc/knowledge/`, versioned, PR-reviewed and visible to
adopters; (b) a private sibling repo, which is the kit's default ("keep it private");
(c) a service.
*Considerations:* in-repo gives review and history but exposes content to anyone with
the repo; a sibling repo protects client material but loses PR review in this repo;
a service adds infrastructure and an availability dependency.

**Resolution (2026-10-09, full rubric): Scope decides location, two roots, one index.** Entries with scope `internal` or `universal` live in the tracked root `.ai-sdlc/knowledge/<trunk>/<topic>.md`, reviewed and versioned like every other file. Entries with scope `protected` (client and data-room material) live in a gitignored root `.ai-sdlc/knowledge-protected/` by default, or in a sibling path configured per adopter; they never enter the repository or a PR body. One retrieval index spans both roots. The write path routes on `scope`; a CI check refuses a `protected` entry in the tracked root and the pre-push chain refuses a PR body that cites one; a classification heuristic (source path under a data-room root, client identifiers) flags likely mis-scoped entries. Industry research: Architecture Decision Records (Nygard, adr-tools, AWS guidance) and docs-as-code systems (Backstage TechDocs) keep engineering knowledge in-repo and treat private material as a separate repository with its own access control; this repository already splits the same way (tracked `_decisions/events.jsonl`, gitignored `transcripts/` and `state.db`); services (Glean, Confluence) would put a network call on every hook. Counter-argument: "two roots is the step that gets skipped; a client fact written at `internal` scope to avoid friction is now in the repo; a single private repo cannot leak." Rebuttal: a single private repo moves the risk rather than removing it, strands shared engineering knowledge away from the code it describes and removes PR review; mis-scoping is a classification error the check catches. Selected over all-in-repo because committing client material is unacceptable, over a private sibling repo because review and co-location are the point for engineering knowledge, and over a service because the hot path must not depend on the network.

**OQ-2 - What is the retrieval substrate?**
*Problem:* the index must serve keyword, vector and relation queries.
*Options:* (a) files plus a local index (SQLite FTS5 and a vector table), zero
infrastructure; (b) Elasticsearch plus a vector store plus a graph database, as the
consulting offering describes.
*Considerations:* an adapter boundary is required either way. Local is cheap and
portable; the heavier stack scales and reuses consulting assets but adds operations
burden for adopters.

**Resolution (2026-10-09, full rubric): A local SQLite index behind a `RetrievalIndex` adapter.** The default substrate is one SQLite file under `.ai-sdlc/` (gitignored like `state.db`), holding an FTS5 table for keyword search with BM25 ranking, a vector table fed through the RFC-0019 embedding provider adapter, and an edges table for typed relations queried with recursive CTEs; keyword and vector results are fused with reciprocal rank fusion. The entries on disk remain the source of truth; `cli-context index` rebuilds the file from them, so deleting it loses nothing. The enterprise stack (Elasticsearch, a vector store, a graph database) is a second adapter behind the same interface, delivered where a client corpus justifies it; graphify's `graph.json` is an ingest source for relations, not the substrate. Shipped substrate: RFC-0019 chose JSONL vector storage in its own OQ-1 and named an escape hatch at about 100K entries or 250 ms p95; `better-sqlite3` is already a dependency of three packages; `.ai-sdlc/state.db` already exists as a gitignored local SQLite store. Industry research: SQLite FTS5 and `sqlite-vec` serve keyword and brute-force vector search in-process to the low hundreds of thousands of vectors; reciprocal rank fusion (Cormack et al.; Elastic, Weaviate, Vespa) combines BM25 and vector scores without weight tuning; the enterprise stacks exist for corpora of millions across many systems. Counter-argument: "the offering sells Elasticsearch, RAG and a knowledge graph; shipping SQLite undercuts the pitch and the enterprise adapter is never dogfooded." Rebuttal: the pitch is the outcome, not the vendor list; the adapter boundary lets one codebase serve both; the enterprise adapter is dogfooded in the engagement where such a corpus exists; three services on a stargazer's first run contradicts the first-run goal. Selected over extending the JSONL store because per-message retrieval runs hundreds of times a session and needs indexed lookup, over the enterprise stack by default because the default must run on a laptop with nothing installed, and over graphify as engine because it models code structure, not entries with confidence and decay.

**OQ-3 - Who may write, and at what authority?**
*Problem:* an engine that retrieves its own unverified output can poison itself.
*Options:* (a) agents write only at `inferred` with a re-verify note, and humans
promote; (b) agents may also promote when they attach proof from running code.
*Considerations:* (a) is safer and slower; (b) is faster and needs a definition of
acceptable proof and a way to audit promotions.

**Resolution (2026-10-09, full rubric): Agents write at `inferred` only; a deterministic verifier or a human promotes.** Every agent-written entry carries `authority: inferred`, a confidence cap of 0.85 and a `reverify:` note. Promotion to `specialist` is allowed when a framework verifier (code, not a model) re-runs an attached proof from a closed vocabulary declared in the ontology and it holds: a test id that passes from the committed tree, a decision record id present on `main`, a path present in the tracked tree, a command from an allowlisted set whose output matches. Arbitrary commands are not in the vocabulary. `canonical` requires a human, through the human surface or a PR to the tracked root. Promotion, supersession and refutation are events in the knowledge log; `cli-context audit` lists every promotion with its proof. Re-observation moves confidence 30 percent toward the new value and never changes authority. Industry research: Wikipedia's sourcing model (authority from the cited source, not the editor), SLSA and in-toto provenance (trust set by producer and attestation, never self-declared), this repository's RFC-0046 independence tiers and the decision catalog's rule that `--by` is a claim, and the stored-prompt-injection literature (OWASP LLM01) that AISDLC-729 already applies to transcript-mined memories. Counter-argument: "a verifier that re-runs a proof chosen by the writer is option C with extra steps; the agent picks a command whose output it controls." Rebuttal: the vocabulary is closed, each form resolves against repository state the writer cannot forge at write time, and anything outside it stays `inferred` until a person promotes it; this is the same boundary RFC-0046 draws between `attested` and `isolated`. Selected over human-only promotion because an all-human queue reproduces the hygiene debt the kit documents, over agent self-promotion with proof because self-authored proof is the forgeability this repository has already paid to close once, and over consensus promotion because agents sharing training and prompts give correlated, not independent, observations.

**OQ-4 - What happens to the fixed prefix?**
*Problem:* the session-start slice either replaces CLAUDE.md and the memory index or
sits beside a shrunken version of them.
*Options:* (a) replace; (b) supplement a shrunken fixed prefix.
*Considerations:* governance rules in CLAUDE.md are controls, so moving them into a
retrieved slice is a weakening question. Retrieval can miss; a control that was not
retrieved did not apply. Savings are larger under (a).

**Resolution (2026-10-09, full rubric): Tiered. Controls stay in the fixed prefix; path-bound rules load conditionally; everything else arrives just-in-time.** The fixed prefix is defined by what it may contain, not by size: governance controls rendered from `spec.governance` configuration (RFC-0048), the role and task frame, and pointers, with a target under 10 KB. Rules that bind to files move to `.claude/rules/*.md` with `paths:` frontmatter, which the harness loads deterministically when a matching file is in play, so they never depend on ranking. Explanation, history, rationale and the memory index become knowledge-store content with trunk and decay, surfaced by the six moments. A linter refuses a control-shaped sentence (never, must, refuse, only) outside the prefix unless it is also rendered from configuration. AISDLC-742 and AISDLC-651.2 become this structural rule rather than one-time diets; savings are measured through the cache-versus-JIT report, not assumed. Industry research: prompt caching makes the prefix cheap within a window and expensive at every cache write (subagent start, clear), which continuous clearing multiplies; Claude Code's `.claude/rules/` with `paths:` and `@` imports are a deterministic conditional layer; Cursor, Copilot and Aider converged on a small always-on file plus scoped rule files and none rely on retrieval for rules; RFC-0048 already moved hard rules into configuration rendered by hooks. Counter-argument: "explanatory paragraphs such as the attestation three-way lockstep exist because the short rule was not enough; moved to retrieval, the next agent breaks the lockstep before the engine surfaces the warning." Rebuttal: that paragraph is bound to three named files, exactly what a `paths:` rule loads the moment one is opened; topic-bound rationale is where a 64 KB always-on file already fails by being skimmed, and a ranked slice at the moment of the edit is more likely to be read. Selected over replacing the prefix because a control that depends on retrieval is not a control, over supplementing an unchanged prefix because it saves nothing, and over a deterministic-only scheme because topic-bound rationale has no path trigger.

**OQ-5 - What is the evaluation corpus and who owns the bar?**
*Problem:* ranking must be measured against real questions.
*Options:* (a) mined from transcripts (real, untrusted); (b) hand-authored golden
questions; (c) both.
*Considerations:* mined questions reflect real use but are untrusted text and can
drift; golden questions are stable but narrow. Someone must own the pass threshold.

**Resolution (2026-10-09, full rubric): Layered corpus; a hand-authored golden set gates, mined and synthetic sets report.** A hand-authored golden set of questions with relevance judgments is the regression gate: recall at 5 of at least 0.8 to pass and no regression beyond 2 points per release, both as configuration (`evaluation.goldenRecallAt5`, `evaluation.maxRegressionPoints`) changed only through a decision record, following RFC-0050's weekly routing decision. Questions mined from session transcripts are quarantined as evaluator-only data (never a prompt to an agent), scrubbed, de-duplicated and refreshed on a schedule; they report and do not gate, and a mined question that fails is a candidate for the golden set. Synthetic questions generated from entries fill coverage gaps. A golden question whose entry no longer exists retires. The production citation rate from the load ledger (an injected entry later cited or acted on) is the complementary signal, not the gate. Industry research: TREC-style fixed collections with relevance judgments and recall, MRR and nDCG; RAG evaluation practice (RAGAS, BEIR, provider cookbooks) layering golden and synthetic sets; this repository's RFC-0050 bar and asymmetric change rule, RFC-0052's 50-PR shadow window, and AISDLC-729's treatment of transcript-mined content as proposals. Counter-argument: "golden sets rot; six months in every run passes against a codebase that no longer exists while the real questions have moved; only mining tracks reality." Rebuttal: rot is handled by the promotion path from mined failures, the retirement rule, and the production citation rate; noise in the gate cannot be handled at all, because a moving threshold is no threshold. Selected over mined-only because a regression gate must be stable, over golden-only because authored questions miss the unimagined failure, and over an online-only signal because a measure that lags weeks cannot gate a merge.

**OQ-6 - Is auto-memory one trunk or a separate store?**
*Problem:* the Claude auto-memory folder overlaps the knowledge layer.
*Options:* (a) it becomes one trunk of the store, with AISDLC-729's dream as its
hygiene pass; (b) it stays separate behind a bridge.
*Considerations:* unification removes a store and a hygiene process; separation
keeps Claude Code's own memory behavior untouched.

**Resolution (2026-10-09, full rubric): Auto-memory is indexed as a trunk and stored where it is.** The memory folder keeps its file format and remains the harness's write target; the engine ingests every note as an entry in a `memory` trunk at `scope: protected`, with authority from the note type (`user` and `feedback` notes map to `specialist` with the operator as source, `project` and `reference` to `inferred`) and the note file as the citation. AISDLC-729's dream stays the hygiene pass for that folder, and its folder swap triggers a re-ingest under the lock 729 specifies. Harness recall stays on; the load-once ledger marks a note as loaded whenever either path surfaces it, so the memory index can leave the fixed prefix as OQ-4 requires without duplicate injection. Disabling harness recall is revisited only when the cache-versus-JIT report shows it adds nothing over the engine's ranking. Industry research: the managed-agents dream design and agent-memory systems (MemGPT, Letta, Mem0) keep episodic memory separate from declarative knowledge at the storage level while one retriever reads both; the kit's routing table distinguishes owner-stated facts from captured knowledge by authority and source, which is the same mapping. Counter-argument: "two systems surfacing the same note is the duplication the operator asked to eliminate; either the engine owns memory or the harness does." Rebuttal: the ledger is the accountability mechanism and records who surfaced what; the report will show whether harness recall adds anything, which is the evidence a write-only design needs first. Selected over full unification because the harness write path and free-form note writing are worth keeping, over a bridge because nothing else would surface memory outside the prefix, and over write-only memory because a working recall path should be turned off on evidence, not before it.

**OQ-7 - Is the client data room a trunk or a separate root?**
*Problem:* data-room documents, SOPs and sources are `protected` content.
*Options:* (a) a trunk of this engine; (b) a separate content root indexed read-only.
*Considerations:* a trunk reuses the schema and hygiene; a separate root keeps client
material out of the engine's write paths and out of any shared store.

**Resolution (2026-10-09, full rubric): The data room is a separate raw root indexed read-only; what is captured from it becomes protected entries.** Documents, SOPs and sources live in an optional configured root (`knowledge.dataRoomRoot`, possibly a sibling repository), indexed read-only at `scope: protected` with authority from document kind as the kit prescribes (signed documents canonical at 0.95, decks and plans 0.7 to 0.85). The PreToolUse hook denies writes under that root unless the active task's `permittedExternalPaths` names it, reusing the shipped allowlist. Capture writes entries, not documents: facts taken from a document become `protected` entries in the protected root from OQ-1, with a citation to the source, under the full schema, hygiene and decay. One index spans both, partitioned by scope, so the protected partition is excluded from any export or sharing path by scope alone. Industry research: virtual data rooms (Intralinks, Datasite) are read-only with access audit and nothing written back; enterprise search (Glean, Elastic Workplace Search) indexes roots it does not own and keeps derived indexes disposable; the kit's own split of raw `sources/` from captured `knowledge/` with a `cite`. Counter-argument: "read-only indexing still copies client text into an index file and into agent context; if client material must never leave the room, never indexing is the only honest answer." Rebuttal: the index is on the same machine as the room, gitignored and partitioned by scope, and agent context is where the material must go for the engine to be worth anything; the control is that nothing derived from protected content reaches a tracked root or a PR body, not that the content is never read. Selected over ingesting documents as entries because documents and entries are different objects with different write rules, over an unindexed room because it solves nothing, and over a separate index because one query must span client knowledge and project decisions.

**OQ-8 - Trigger policy and profile defaults**
*Problem:* which moments fire by default, for which roles, at what budgets and
relevance floor, and who may change a profile.
*Options:* (a) all six moments on for every role, with a relevance floor and a
per-N-turns cap; (b) session start and task claim on for every role, with per-message
and per-tool on by default only for the planner profile and opt-in for others (the
planner-authored default above); (c) opt-in everywhere, so nothing fires until a
profile enables it.
*Considerations:* planner sessions benefit most from mid-conversation surfacing, while
loop roles (dispatch, executors) pay the most per enabled moment. The cache-versus-JIT
report is the evidence that should settle the defaults after a measured window,
mirroring RFC-0050's asymmetric routing changes (cheaper needs evidence, safer is
automatic). Open whether profile edits are governance-adjacent (they change what
agents see but remove no control) and so stay class (a). The planner recommends (b);
the question stays open.

**Resolution (2026-10-09, full rubric): Narrow by role, widen by evidence.** Session start and task claim are on for every role; the per-message and per-tool moments are on by default only for the planner profile and opt-in elsewhere, except that executors have per-tool on for governance-bearing paths; compaction is on wherever session start is. Every moment has a per-role token budget, relevance floor and a per-N-turns cap. Defaults: planner all moments at the largest budgets; operator-dispatch session start, task claim and compaction; executors session start and task claim at small budgets plus per-tool on governance paths; reviewers task claim only; haiku relays session start only. Model alias is a secondary key in the profile schema, never the primary one, because DEC-0041 and DEC-0068 move roles between models. Defaults change only through a decision record backed by the cache-versus-JIT report, asymmetric as in RFC-0050 Part B: adding a moment or raising a budget needs evidence, removing or lowering is automatic. Profile edits are class (a): they change what agents see and remove no control, since OQ-4 keeps every control in the fixed prefix regardless of profile. Industry research: feature-flag practice (ship narrow, measure, widen); this repository's RFC-0049 shadow default, RFC-0050 asymmetric routing and RFC-0052 shadow window; the 2026-10-08 audit placing idle loop sessions at 69 percent of spend and the planner at 2 percent. Counter-argument: "executors are where context failures cost real money; a developer that does not know the patch-id lockstep ships a broken PR and a fix round pays for it; starving the executor profile optimizes the cheap thing." Rebuttal: path-bound governance knowledge is covered by OQ-4's deterministic rules loading and by the executor's per-tool moment on governance paths, both on by default; what is withheld is per-message retrieval, and an executor's messages are task body and tool output, not questions; if the report shows preventable fix rounds, the asymmetric rule widens the profile by decision record. Selected over all-on because paying for an unmeasured ranking in the highest-volume roles precedes the evidence, over opt-in-everywhere because an engine nobody turns on produces no evidence (the dark-code gate exists for that failure), and over alias-keyed profiles because role predicts benefit and model assignment moves under roles.

## References

- `forge-data-room-kit/` (private, gitignored; prior art only, no content copied).
- [[RFC-0008]] (PPA); [[RFC-0011]] (DoR); [[RFC-0019]] (provider adapter);
  [[RFC-0029]]; [[RFC-0035]] (Decision Catalog); [[RFC-0050]] (usage ledger).
- AISDLC-651.2 (fixed-prefix measurement), AISDLC-729 (memory dream),
  AISDLC-742 (CLAUDE.md condense).

## Sign-Off

| Role | Owner | Status |
| --- | --- | --- |
| Engineering | Dominique Legault | ✅ Signed (all 8 OQs resolved via full rubric; 2026-10-09) |
| Operator | Dominique Legault | ✅ Signed (all 8 OQs resolved via full rubric; 2026-10-09) |
| Product | Alex | ⏸ Pending |
| Design | Morgan | ⏸ Pending |

## Revision History

| Date | Change |
| --- | --- |
| 2026-10-09 | Initial Draft. 7 Open Questions, none resolved. Trigger: planner design brief. |
| 2026-10-09 | Surfacing protocol: six moments, compaction, load-once ledger, role/model profiles, cache-vs-JIT measurement; OQ-8 added (open) |
| 2026-10-09 | OQ-1, OQ-2, OQ-3 resolved via operator rubric (scope-split roots; SQLite adapter; inferred-only writes with verifier/human promotion); phase-1 tasks AISDLC-773 to AISDLC-777 filed |
| 2026-10-09 | OQ-4..8 resolved via operator rubric (tiered prefix; layered eval corpus; memory as indexed trunk; data room read-only root; narrow-by-role triggers); Engineering + Operator signed; lifecycle Draft → Signed Off; phase 2-4 tasks AISDLC-778..788 |
