# RFC: {{title}}

> Scaffolded by `ai-sdlc rfc init {{slug}}` on {{createdDate}}.
> Replace this notice once the RFC is ready for review.

**Status:** Draft
**Author:** {{author}}
**Created:** {{createdDate}}

## Summary

A one-paragraph statement of the decision this RFC settles. What is being
decided, for whom, and why now? Keep it short — the body sections below
carry the rigor.

## Background

What is the current state of the world that motivates this decision? Link
to prior work, existing tickets, and any earlier RFCs (or specs / docs)
that this proposal supersedes or amends. If a prior approach is being
revisited, name the trigger — what changed that made the previous answer
insufficient.

## Open Questions

Use this section to capture decisions that the team has NOT yet made. Each
question should be answerable in the **Decisions** section below once
resolved (do not delete answered questions — keep them with their
**Resolution:** marker so the audit trail survives).

1. ?
2. ?

> **Note:** unresolved Open Questions in this section will be treated as
> blockers by the AI-SDLC DoR upstream-OQ gate if this RFC is referenced
> by a backlog task. To unblock a dependent task before all OQs are
> answered, add a `blocked.reason:` override to the task's frontmatter
> documenting the acknowledgement.

## Decisions

For each Open Question above that has been resolved, record the **chosen
option**, the **rationale**, and the **trade-offs accepted**. Composes
with the [AI-SDLC Decision Catalog](https://ai-sdlc.io/concepts/decision-catalog)
when present — the catalog is the operator-facing routing surface for
these decisions; this section is the durable narrative.

- **OQ-1 — <question>**
  **Resolution:** <option chosen>
  **Rationale:** <why this option won>
  **Trade-offs:** <what is given up>

## Phases

Break the implementation into phases small enough to ship one PR each.
Each phase should have a one-line summary plus a checklist of acceptance
criteria. The framework's backlog system will mirror these as discrete
tasks once the RFC reaches `Ready for Review`.

- [ ] **Phase 1** — <one-line summary>
  - AC: <criterion>
- [ ] **Phase 2** — <one-line summary>
  - AC: <criterion>

## Acceptance

A consolidated checklist that the RFC's owners use to determine
"done-ness." This is the single bar this RFC's implementation must clear
before its lifecycle promotes to `Implemented`.

- [ ] All phases above shipped
- [ ] Documentation updated (link)
- [ ] Tutorial / migration guide updated (if applicable)
- [ ] All Open Questions resolved with **Resolution:** markers

## References

Link to upstream RFCs, framework docs, external papers, prior tickets,
and any spec-kit specs that motivated this work.

- [AI-SDLC three-tier authoring model](https://ai-sdlc.io/concepts/spec-driven)
- <other references>
