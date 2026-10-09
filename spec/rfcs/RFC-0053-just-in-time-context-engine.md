---
id: RFC-0053
title: Just-In-Time Context Engine (Decision Context Engine)
status: Draft
lifecycle: Draft
author: 'Dominique Legault'
created: 2026-10-09
updated: 2026-10-09
targetSpecVersion: v1alpha1
requires: [RFC-0019, RFC-0035]
assumes: [RFC-0008, RFC-0011, RFC-0029, RFC-0050]
requiresDocs: []
---

# RFC-0053: Just-In-Time Context Engine (Decision Context Engine)

**Status:** Draft (2026-10-09). All 8 Open Questions are unresolved and wait for an
operator walkthrough. No sign-off has been given.

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
(location is OQ-1). Trunks are engineering domains: systems, products, customers,
decisions, people, process. Every entry has a trunk, a type and relations. An ontology
file declares the entry types and the relations allowed between them.

Ingest adapters project what ai-sdlc already structures into entries, so the engine
starts populated and stays current without double entry:

- Decision catalog events (RFC-0035).
- RFCs: frontmatter and Open Question resolutions.
- Review logs and the reviews ledger.
- Orchestrator events.
- Auto-memory notes.
- Backlog tasks.

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
repeats itself. The substrate is OQ-2; the adapter
boundary exists either way.

An evaluation set of real agent questions, mined from transcripts and treated as
untrusted text, is scored for precision so ranking is evidence, not assumption
(OQ-5).

### C. Surfacing protocol

Six moments and a compaction rule:

1. **Session start** (`SessionStart` hook). A budgeted slice replaces or supplements
   the fixed prefix (OQ-4).
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

A profile may also key on the model alias; haiku relays get nothing beyond session
start. Profiles are configuration, not governance controls: a smaller profile never
removes a hard rule. Which defaults ship is OQ-8.

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

### Human surface

Query, confirm, correct and supersede entries. A coverage dashboard presented as a gap
list. External signals (support, CRM, analytics, roadmap) flow into the PPA (RFC-0008)
as inputs. Token savings are measured through the RFC-0050 usage ledger.

## Phases

Tasks are filed later, not in this PR.

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
  slice is a weakening question (OQ-4) and must not happen by default.
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

All unresolved. Each is written as problem, options and considerations, for the
operator walkthrough.

**OQ-1 - Where does the store live?**
*Problem:* location decides visibility, review and trust, and data-room content
depends on it.
*Options:* (a) in-repo `.ai-sdlc/knowledge/`, versioned, PR-reviewed and visible to
adopters; (b) a private sibling repo, which is the kit's default ("keep it private");
(c) a service.
*Considerations:* in-repo gives review and history but exposes content to anyone with
the repo; a sibling repo protects client material but loses PR review in this repo;
a service adds infrastructure and an availability dependency.

**OQ-2 - What is the retrieval substrate?**
*Problem:* the index must serve keyword, vector and relation queries.
*Options:* (a) files plus a local index (SQLite FTS5 and a vector table), zero
infrastructure; (b) Elasticsearch plus a vector store plus a graph database, as the
consulting offering describes.
*Considerations:* an adapter boundary is required either way. Local is cheap and
portable; the heavier stack scales and reuses consulting assets but adds operations
burden for adopters.

**OQ-3 - Who may write, and at what authority?**
*Problem:* an engine that retrieves its own unverified output can poison itself.
*Options:* (a) agents write only at `inferred` with a re-verify note, and humans
promote; (b) agents may also promote when they attach proof from running code.
*Considerations:* (a) is safer and slower; (b) is faster and needs a definition of
acceptable proof and a way to audit promotions.

**OQ-4 - What happens to the fixed prefix?**
*Problem:* the session-start slice either replaces CLAUDE.md and the memory index or
sits beside a shrunken version of them.
*Options:* (a) replace; (b) supplement a shrunken fixed prefix.
*Considerations:* governance rules in CLAUDE.md are controls, so moving them into a
retrieved slice is a weakening question. Retrieval can miss; a control that was not
retrieved did not apply. Savings are larger under (a).

**OQ-5 - What is the evaluation corpus and who owns the bar?**
*Problem:* ranking must be measured against real questions.
*Options:* (a) mined from transcripts (real, untrusted); (b) hand-authored golden
questions; (c) both.
*Considerations:* mined questions reflect real use but are untrusted text and can
drift; golden questions are stable but narrow. Someone must own the pass threshold.

**OQ-6 - Is auto-memory one trunk or a separate store?**
*Problem:* the Claude auto-memory folder overlaps the knowledge layer.
*Options:* (a) it becomes one trunk of the store, with AISDLC-729's dream as its
hygiene pass; (b) it stays separate behind a bridge.
*Considerations:* unification removes a store and a hygiene process; separation
keeps Claude Code's own memory behavior untouched.

**OQ-7 - Is the client data room a trunk or a separate root?**
*Problem:* data-room documents, SOPs and sources are `protected` content.
*Options:* (a) a trunk of this engine; (b) a separate content root indexed read-only.
*Considerations:* a trunk reuses the schema and hygiene; a separate root keeps client
material out of the engine's write paths and out of any shared store.

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

## References

- `forge-data-room-kit/` (private, gitignored; prior art only, no content copied).
- [[RFC-0008]] (PPA); [[RFC-0011]] (DoR); [[RFC-0019]] (provider adapter);
  [[RFC-0029]]; [[RFC-0035]] (Decision Catalog); [[RFC-0050]] (usage ledger).
- AISDLC-651.2 (fixed-prefix measurement), AISDLC-729 (memory dream),
  AISDLC-742 (CLAUDE.md condense).

## Sign-Off

| Role | Owner | Status |
| --- | --- | --- |
| Engineering | Dominique Legault | ⏸ Pending |
| Operator | Dominique Legault | ⏸ Pending |
| Product | Alex | ⏸ Pending |
| Design | Morgan | ⏸ Pending |

## Revision History

| Date | Change |
| --- | --- |
| 2026-10-09 | Initial Draft. 7 Open Questions, none resolved. Trigger: planner design brief. |
| 2026-10-09 | Surfacing protocol: six moments, compaction, load-once ledger, role/model profiles, cache-vs-JIT measurement; OQ-8 added (open) |
