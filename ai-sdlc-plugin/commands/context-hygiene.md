---
name: context-hygiene
description: Audit the knowledge store for contradictions and stale entries; raise at most 3 contradictions per run as Decision Catalog items and report stale entries as questions. Monthly cadence.
argument-hint: '[--monthly]'
allowed-tools: Bash, Read
model: sonnet
rung: 4
---

Hygiene pass for the context engine (RFC-0053). Adapted from the knowledge-hygiene mechanics of the data-room kit. Run it monthly (`--monthly` runs the full audit) or on demand.

## Rules (hard)

1. **Never change authority.** Promotion is the verifier's or a human's job; hygiene does not promote, demote or relabel.
2. **Never delete an entry.** Hygiene only reads entries and reports. Corrections go through `/ai-sdlc context-capture` as a superseding entry.
3. **Stale means a question, not a fact.** Freshness = 0.5^(age / half-life). An entry with freshness below 0.3 is reported under "Questions to re-verify", phrased as a question using its `reverify:` note, never as a statement of fact.
4. **Contradictions become Decision Catalog items.** Detect pairs of entries joined by a `contradicts` relation or stating incompatible values for the same subject. Raise each with:
   ```bash
   node pipeline-cli/bin/cli-decisions.mjs add \
     --summary "Knowledge contradiction: <subject>" \
     --body "<entry A id and value> conflicts with <entry B id and value>. Sources: <citations>." \
     --scope workspace \
     --source emergent-finding \
     --option "keep-a:Keep <entry A id>" \
     --option "keep-b:Keep <entry B id>" \
     --option "neither:Supersede both with a corrected entry"
   ```
5. **At most 3 contradictions are raised per run.** Rank by effective confidence (confidence x freshness), raise the top 3, and list the remainder in the report as "deferred to next run".
6. Running code outranks every written entry: when one side of a contradiction can be checked against the tree, say so in the body.

## Steps

1. Load all entries from both knowledge roots (skip nothing for scope; do not copy protected content into any tracked file or decision body, cite entry ids only for protected entries).
2. Compute freshness per entry; collect stale entries (below 0.3).
3. Detect contradictions; raise up to 3 per rule 4 and 5.
4. Print the report: contradictions raised (with DEC ids), deferred contradictions, questions to re-verify, and entry counts by band.
