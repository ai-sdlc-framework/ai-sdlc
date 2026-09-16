---
id: AISDLC-621
title: DoR hermetic Gate 3 must SKIP url/github refs, not fail them (unblocks doc-linking issues)
status: Done
priority: high
labels:
  - dor
  - ingress
  - bug
created: 2026-09-16
---

## Context

Root cause of a recurring auto-dispatch failure: any GitHub issue (or backlog
task) whose body cites a **documentation URL** (or a github-issue reference) is
falsely marked `status:needs-clarification` by the DoR ingress and refused by
`/ai-sdlc execute`. Observed on issue #1070, whose only DoR failure was:

> **Gate 3 — Named-thing references resolve**
> 1 reference(s) failed to resolve: https://ai-sdlc.io/docs/api-reference/runners
> (no resolver registered for reference shape).

## Root cause (confirmed)

`pipeline-cli/src/dor/evaluate.ts` → `evaluateGate3Hermetic()` (~lines 133-152).
The DoR **ingress runs in hermetic mode** (`dor-evaluate` / `dor-check` default
`hermetic: true`). In hermetic mode the function REPLACES the resolver registry
with **`[fileExistenceResolver]` only**, dropping `urlHeadResolver` and
`githubIssueResolver`. The stated intent (per the comment) is "vacuous pass —
exclude Stage A's network-touching half," BUT the implementation still RUNS
gate 3 with that file-only resolver set. So `resolveReference()` finds no
resolver whose `supports()` matches a `kind:'url'` or `kind:'github-issue'`
reference and returns `{resolved:false, reason:'no resolver registered for
reference shape'}` → gate 3 **fails** (block) → `needs-clarification`.

Net: hermetic mode does not SKIP network refs — it evaluates them against a
resolver that structurally cannot handle them, converting "can't check offline"
into "reference is broken." Every issue that links docs is false-blocked.

## Scope

- In hermetic mode, network-touching references (kinds `url` and `github-issue`)
  must be treated as **skip / pass** (they cannot be verified offline and must
  NOT block), while local `file-existence` references are still checked. Prefer
  one of:
  - Filter `url`/`github-issue` refs out of the set evaluated in hermetic mode
    (so only file-existence refs are checked), OR
  - Provide hermetic "skip resolvers" for `url` and `github-issue` kinds that
    return `{resolved:true}` with a `reason` noting the hermetic skip — so a
    future non-hermetic run can still verify them.
  Do NOT simply add the real network resolvers to the hermetic set (that would
  re-introduce network calls the hermetic mode exists to avoid).
- Keep NON-hermetic behavior unchanged: with `hermetic:false` the full
  DEFAULT_RESOLVERS set (incl. url-head) still runs and a genuinely-dead URL
  (HTTP 4xx/5xx) still fails gate 3.
- Ensure the fix flows through the `dor-evaluate` (GH-issue ingress) AND
  `dor-check` (backlog task) paths — both default hermetic.

## Acceptance Criteria

- [ ] AC-1: An issue/task body citing a live documentation URL (e.g.
      `https://ai-sdlc.io/docs/...`) evaluated in HERMETIC mode does NOT fail
      gate 3 with "no resolver registered" — gate 3 passes (or skips the url
      ref) while still checking any file-existence refs.
- [ ] AC-2: A `closes #N` / `gh#N` reference in hermetic mode likewise does not
      false-fail gate 3.
- [ ] AC-3: NON-hermetic mode unchanged — a URL returning HTTP 404 still fails
      gate 3 (regression test with an injected `fetchImpl`).
- [ ] AC-4: A local file-existence reference to a missing file STILL fails gate 3
      in hermetic mode (the offline check is preserved).
- [ ] AC-5: Hermetic tests cover url + github-issue skip and the preserved
      file-existence failure; `pnpm build && test && lint && format:check` clean;
      patch coverage >= 80%.

## References

Surfaced by issue #1070 (a well-specified, security-passed, complexity-1 bug
blocked purely because it links a docs URL). Code:
`pipeline-cli/src/dor/evaluate.ts` (`evaluateGate3Hermetic`),
`pipeline-cli/src/dor/gates/gate-3-references.ts`,
`pipeline-cli/src/dor/resolvers/` (url-head, github-issue, file-existence).
Note: a separate PPA-threshold factor (score 0.026 < 0.05 min) also gates
auto-dispatch of low-demand issues — out of scope here; this task only fixes the
false Gate-3 block.
