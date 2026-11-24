---
name: decision-rubric
description: Apply a rigorous decision rubric when asking the user for a non-trivial design, architectural, or policy choice via AskUserQuestion. Six steps — question the requirement → problem statement → evidence tagged checked or unchecked → 3-4 options plus "what would reject all of these?" → recommendation, counter-argument and dependency trace → domain review — presented decision first, with the one thing to check. Replaces shallow "do you agree with the author's recommendation?" prompts. Invoke whenever the user is being asked to resolve an open question on ANY work item — an RFC, a backlog task, a GitHub/Jira/Linear issue, a design doc — or to pick a library or pattern, set a default, choose a deprecation policy, or make any choice they would later regret if the framing were shallow. Do NOT use for trivial preferences (naming, formatting, which file to edit first) — those get a plain AskUserQuestion.
---

# Decision rubric — how to ask the operator a non-trivial design question

The rubric was first built to stop one failure: read the open question, restate the author's lean, ask "agree?". The operator picks "yes" because nothing else is on the table, and the author's decision is rubber-stamped. It does that job.

A review of about 37 decisions that were later reversed or amended (DEC records and RFC resolutions, 2026-11-23) found that rubber-stamping caused only 2 of them. Nine of 18 amended RFC resolutions had used the full rubric. The causes the old rubric never checked:

| Cause | Cases | Examples | Step that catches it |
|---|---|---|---|
| The decision relied on a record, data source or emitter nobody defined, or a guard never tried on real traffic | ~11 | RFC-0018 v0.4 → v0.4.1; the DEC-0046 guard refused 100% of real messages; DEC-0222 broke every adopter install | 5 (trace) |
| A fact was wrong or never checked against its source | ~10 | WCAG called "superseded"; WCAG 3.0 in an enum; DEC-0284 kept code for envelopes that never existed | 3 (evidence) |
| The right answer wasn't among the options | ~7 | DEC-0286: every option rejected; DEC-0200: a list where a rule was needed | 4 (reject-all question) |
| The requirement shouldn't have existed | ~6 | DEC-0267: a hook with ten false refusals; DEC-0392: a "30 min" limit nobody asked for | 1 (question the requirement) |
| No domain expert was consulted | 2 | RFC-0018: the Design Authority saw it 6 months later | 6 (domain review) |

Counts are approximate; many cases had two causes.

## When to invoke this rubric

**YES** when the user is choosing:

- An open-question or design-decision resolution on any work item (RFC Open Question, backlog task design point, GitHub / Jira / Linear issue, design-doc thread)
- A default that ships to adopters (timeouts, retry counts, grace periods, thresholds)
- A library, framework or major dependency
- An architectural pattern, a deprecation or migration policy, or a schema shape that is hard to change later
- A trade-off between two real engineering concerns
- Anything where the answer depends on context the user has and you don't

**NO** when:

- The choice is a personal preference, or reversible in under 5 minutes
- One option is dominant on every axis
- The user already stated a preference in this session or in memory
- You are asking for a missing fact ("which branch?"): plain AskUserQuestion or ask in text

## The six steps

Every step is required when the rubric applies. Steps 1, 3 and 5 are where past decisions failed; they are the ones not to skim.

### 1. Question the requirement

Before solving the problem, ask whether it should exist (DEC-0090 five-step algorithm, steps 1-2):

- What is this requirement for, and **who set it** (a name, a decision id, an RFC section; not "the system")?
- Does that reason still hold today?
- What happens if we delete it?

"Delete it" (or "don't add it") is always one of the options in step 4 unless you can state why deletion is impossible. A default, limit or guard with no traceable author is a deletion candidate, not a given.

### 2. Problem statement

Restate the decision in two sentences in your own words and name the trade-off axes. Split sub-questions instead of lumping them. If you can't write it in two sentences, you don't understand the question yet.

### 3. Evidence, each claim tagged

List the key facts the recommendation rests on, from comparable systems and from this repository. Tag each one:

- **checked**: you saw the source in this session. Give the URL and the date you read it, or the grep, query or command you ran and its result.
- **unchecked**: from memory, from the RFC author, or inferred. Say so.

Rules:

- **The status of any standard is always checked** (Draft, Candidate Recommendation, Recommendation, superseded, withdrawn), and so is its version. A standard's status from memory is the single most common wrong fact in past resolutions.
- A claim about this repository ("X is already shipped", "nothing reads Y") is checked with a grep or a run, never assumed.
- Don't fabricate. If you can't check something that matters, keep it unchecked and say what checking it would take.

### 4. Three to four options

A table with option, pros, cons and verdict (or the axis that matters: cost, complexity, rigor). Each option is genuinely different; two flavors of one answer hide the real decision. Include the author's lean, at least one real alternative, and deletion (step 1) where it applies.

Then answer, in one or two sentences: **"What would make us reject all of these?"** If the answer is plausible (a rule where the options are lists, a different owner, a different layer), add that option or restate the problem.

### 5. Recommendation, counter-argument and trace

- **Recommendation.** State it.
- **Counter-argument.** Write the strongest case against it ("the strongest case against this is…", not "someone might say…") and say why the recommendation survives. A weak counter-argument is the same failure as none.
- **Trace.** List every record, data source, emitter, schema, config field, hook and CLI the answer reads or writes. Mark each **exists** (with its path) or **undefined**. An undefined dependency is either specified now, as part of the resolution, or named as an implementation task that must land first. A resolution that reads a record nobody writes is not finished.
- **Silent failure.** One sentence: how could this fail without anyone noticing, and what would show it?
- **Guards.** Before adopting a guard, refusal or filter, run it against at least one real event (a real message, PR, payload or log line) and report the result. A guard that has never seen real traffic is unchecked.

### 6. Domain review

If an authority owns the area (design, accessibility, legal, security, product, a named RFC co-author), the resolution is **provisional** until they review it. Name the owner and how they will be asked. Don't let a provisional resolution be signed as final, and don't wait silently: record the pending review in the resolution and the hand-off.

## How it is shown to the operator

Lead with the decision; the rubric is the appendix, not the preamble. Every rubric message opens with at most four short chunks:

1. **The pick** and why, in one or two sentences.
2. **What it costs**: the concrete price (latency, scope, a control loosened, work created).
3. **The one thing to check**: the weakest unchecked fact from step 3 or the riskiest undefined item from step 5, phrased so the operator can verify it in a minute.
4. **Your call**: what you need from them.

The six steps follow below that, kept tight (200-400 words). Then the AskUserQuestion:

- Exactly 3-4 mutually exclusive options; the recommendation first with `(Recommended)` in the label. All options stay clickable; one recommendation in prose never removes the alternatives from the question.
- Each `description` is 1-3 sentences naming what the choice costs or buys on the axes from step 2. Numbers and consequences, not "safer" or "may be slower".
- `header`: a 1-3 word chip ("Storage backend", "Deprecation").

After the answer, close the loop: say what you recorded and where.

## Worked example (shape only)

> ### OQ-1: Vector storage backend — JSONL vs sqlite?
>
> **Pick: A, JSONL append-only, with the `EmbeddingStorageBackend` interface as the escape hatch.** It matches every other substrate in the repo. **Costs:** a linear scan, about 50 ms at 10K vectors. **Check this:** that adopter corpora stay under ~100K vectors in v1 (unchecked; from the RFC author). **Your call:** pick a backend below.
>
> 1. **Requirement.** Vectors must survive pipeline runs (RFC-0019 §4, set by the RFC author); still holds: the cache depends on it. Deletion means re-embedding every run.
> 2. **Problem.** Read pattern is textHash lookups, write pattern append-on-embed; trade-off is debuggability and substrate consistency vs lookup speed at scale.
> 3. **Evidence.** `_dor/`, `_deps/`, `_decisions/` all use JSONL append-only (checked: `ls .ai-sdlc/`). Cosine over 10K 1536-dim vectors ≈ 50 ms in JS (checked: local benchmark). LangChain/LlamaIndex default to in-process stores (unchecked).
> 4. **Options.** A JSONL / B sqlite / C Parquet / D no default. Reject-all: a remote vector DB, ruled out because bootstrap must work offline.
> 5. **Counter-argument:** "use sqlite from day one; nobody reads floats by eye." Survives because the JSONL value is `jq`/`grep` provenance audits, not reading vectors. **Trace:** store file (exists), GC job (exists), escalation heuristic config field (undefined: specified in this resolution). **Silent failure:** p95 read latency creeps past 250 ms unnoticed; the heuristic logs it.
> 6. **Domain review:** none owns this area.

## Anti-patterns

- **Asking "do you agree with the recommendation?"** That is a sanity check, not a decision. With one real option, just do it.
- **The recommendation only in prose, not a clickable option.**
- **Hedged costs** ("may be slower"): write the number.
- **Non-exclusive options**: collapse them.
- **Skipping the counter-argument because the answer feels obvious.** If it is obvious, you didn't need the rubric.
- **Letting the author's lean frame every option.** It is one option, not the frame.
- **Batch-resolving several questions in one AskUserQuestion.** One rubric and one question per non-trivial question.
- **A fact from memory presented as research.** Tag it unchecked.
- **A resolution that names a record, emitter or field without saying whether it exists.**

## Autonomous mode (no operator present)

When a decision record on `main` authorizes class (a) or (b) and no operator is present, run all six steps and replace only the question:

1. Same requirement check, problem, tagged evidence, options, counter-argument and trace. Autonomous mode lowers the asking, not the rigor. A step-6 domain owner still gets the review; the resolution is recorded as provisional.
2. Classify using `CLAUDE.md` "Decision authority": reversibility, blast radius, and whether it changes a trust-chain or governance control. Class (c) (legal and licensing, money, accounts and credentials, actions only the operator's identity can perform) is never self-decided: `cli-decisions escalate`, park only that task, keep working other eligible tasks.
3. **Do not call AskUserQuestion.** Select the recommendation and record it:
   - class (a): `cli-decisions add --summary ... --scope ... --option "<id>:<description>"` then `cli-decisions answer <id> <option> --rationale "<...>"`, and apply it at once;
   - class (b): `cli-decisions add ... --timebox PT10H --autonomous-fallback <option-id>` (default 10 hours: `timeboxWindowHours` and `timeboxWindowCount` in config; omitting `--timebox` applies it) and apply it when the timebox lapses without an override. When the decision weakens a control, also pass `--governance-change weakening --weakens <option-id>`; the fallback must then be a non-weakening option.
4. Before adding, check the catalog for an open record with the same summary (`cli-decisions list`); answer or supersede it instead of recording a duplicate. A duplicate left open can be answered later by its own timebox and contradict the operator's ruling on the copy.

The operator can override any of these with `cli-decisions answer` or `extend`. Guardrails and hooks are never bypassed by a decision made this way.

## Recording the resolution

Write the resolution where the work item's decisions live (RFC body, task, issue, catalog record) with its rationale, never a bare "answer: A". The rationale is 3-5 sentences and always carries:

- the problem and the pick;
- the counter-argument and why the pick survives;
- **`Check:`** the one thing to check from the presentation, so a later amendment can say which fact failed;
- any **undefined** dependency from the trace and the task that defines it;
- **`Provisional:`** the domain owner, when step 6 applies.

For catalog-routed decisions (Decision Catalog enabled, `AI_SDLC_DECISION_CATALOG`, default on), put this in `--rationale` on `cli-decisions answer`, so `cli-decisions operator-digest` shows it.

## Compose with other patterns

- Multi-question walkthroughs (an RFC, epic or ticket with N open questions): apply the rubric N times; see [[rfc-oq-walkthrough]].
- The rubric is source-agnostic: an RFC Open Questions section, a backlog task, an issue or a review thread all get the same six steps. Only the write-back target differs.
