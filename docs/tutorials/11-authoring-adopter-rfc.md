# Tutorial 11: Authoring an Adopter RFC

> See [RFC-0036](../../spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md) for the normative spec and [`docs/concepts/spec-driven.md`](../concepts/spec-driven.md) for the three-tier authoring model.

AI-SDLC ships an optional, lightweight **adopter RFC scaffold** for the
class of cross-cutting decisions that sit above the Task altitude but
below the framework's own internal RFC ceremony. This is the artifact
to reach for when your team is making a multi-week, multi-team, or
cross-cutting decision (multi-tenancy, vector-store migration,
auth-model swap) and the conversation needs a durable narrative —
something a backlog task can't carry.

This tutorial walks the full loop end-to-end: when to write an RFC,
how to use `ai-sdlc rfc init` to scaffold one, how to capture and
resolve Open Questions, and how to compose with the rest of the
framework (Decision Catalog, backlog tasks, DoR upstream-OQ gate).

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Step 1 — Decide whether you need an RFC](#step-1--decide-whether-you-need-an-rfc)
3. [Step 2 — Scaffold the RFC](#step-2--scaffold-the-rfc)
4. [Step 3 — Author the body](#step-3--author-the-body)
5. [Step 4 — Resolve Open Questions](#step-4--resolve-open-questions)
6. [Step 5 — Cross-link from backlog tasks](#step-5--cross-link-from-backlog-tasks)
7. [Step 6 — Promote the lifecycle](#step-6--promote-the-lifecycle)
8. [Worked example: a multi-tenancy RFC](#worked-example-a-multi-tenancy-rfc)
9. [Configuration reference (`.ai-sdlc/adopter-authoring.yaml`)](#configuration-reference-ai-sdlcadopter-authoringyaml)
10. [Why these defaults? — design rationale and RFC-0036 OQ resolutions](#why-these-defaults--design-rationale-and-rfc-0036-oq-resolutions)
11. [Further reading](#further-reading)

---

## 1. Prerequisites

- AI-SDLC installed and initialised (`ai-sdlc init`) — see [Getting Started](../getting-started/README.md).
- The `@ai-sdlc/pipeline-cli` runtime dependency on PATH (the framework's
  install scripts wire this automatically). The `cli-rfc` binary ships
  with that package.
- Optional: the Claude Code plugin installed if you want the
  `/ai-sdlc rfc-init` slash-command surface alongside the CLI.

This tutorial assumes you've read [`docs/concepts/spec-driven.md`](../concepts/spec-driven.md) and understand the three-tier authoring model. The adopter RFC sits at the RFC altitude — above Spec, above Task.

---

## Step 1 — Decide whether you need an RFC

Most adopter work belongs at the Task altitude. Reach for an RFC only
when **all three** of these are true:

1. **The decision is cross-cutting.** It affects more than one feature
   surface (e.g. a data-model change that touches three services, a
   policy that constrains all future tasks in an area).
2. **The decision has multiple viable options.** If there is one
   obviously-right answer, write a task and ship it. RFCs exist to
   document the trade-offs you accepted when alternatives existed.
3. **You will reference this decision later.** Future contributors,
   future you, or a future auditor will need to understand *why* the
   chosen option won. If the answer is "we won't look back at this,"
   skip the ceremony.

When in doubt: **don't write an RFC.** The framework's quality contract
is the DoR Gate, not the RFC. A well-formed task with a clear AC list
is the right artifact 90% of the time.

> **Note:** the adopter RFC scaffold is deliberately lighter than the
> framework's own internal RFC process (`spec/rfcs/RFC-NNNN-*.md`). No
> frontmatter schema, no sign-off ceremony, no lifecycle / requiresDocs
> / registry numbering. Per RFC-0036 §7.3, the artifact is **for human
> alignment, not pipeline admission** — your adopter RFCs are yours to
> evolve.

---

## Step 2 — Scaffold the RFC

Pick a slug. The slug is the filename stem (so the file lands at
`rfcs/<slug>.md`); rules:

- Lowercase ASCII letters, digits, and hyphens only.
- No leading or trailing hyphen.
- No path separators or `..`.
- Maximum 80 chars.

The slug should read like a short descriptive title:
`multi-tenancy-model`, `postgres-vector-migration`, `auth-rotation-policy`.

Scaffold via the CLI:

```bash
ai-sdlc rfc init multi-tenancy-model
```

…or via the Claude Code slash command (functionally identical):

```text
/ai-sdlc rfc-init multi-tenancy-model
```

Either invocation produces:

```
Scaffolded adopter RFC at /Users/<you>/<repo>/rfcs/multi-tenancy-model.md
  slug:       multi-tenancy-model
  title:      Multi Tenancy Model
  rfcDir:     /Users/<you>/<repo>/rfcs/ (source: default)
  template:   <node_modules>/@ai-sdlc/pipeline-cli/templates/framework-rfc.md
  createdAt:  2026-05-27

Next steps:
  1. Open the file and replace the scaffold notice + placeholders.
  2. Capture Open Questions as you draft; resolve them in the Decisions section.
  3. Commit the RFC; cross-link from any backlog tasks via `references:`.
```

### Useful flags

| Flag | Purpose |
|---|---|
| `--title "Multi-Tenancy Model"` | Override the slug-derived title. |
| `--author "Dominique Legault"` | Author name written into the template. |
| `--rfc-dir "../company-rfcs"` | Override the destination directory (for multi-repo adopters). |
| `--force` | Overwrite an existing file (refused by default). |
| `--template <path>` | Use a custom template file. |
| `--format json` | Machine-readable output envelope. |

The scaffold refuses to clobber an existing file unless you pass
`--force` — you cannot accidentally lose draft content.

---

## Step 3 — Author the body

Open the new file. The template ships with seven canonical sections:

1. **Summary** — one paragraph naming the decision, the audience, and
   the why-now.
2. **Background** — the current state of the world that motivated this
   decision; links to prior work and any superseded approaches.
3. **Open Questions** — decisions the team has not yet made. Each
   question stays in the section even after resolution — DON'T delete
   answered questions, keep them with their `**Resolution:**` marker
   so the audit trail survives.
4. **Decisions** — for each resolved Open Question: chosen option,
   rationale, and trade-offs accepted. This is the durable narrative.
5. **Phases** — implementation broken into PR-sized phases with one-
   line summaries and AC checklists.
6. **Acceptance** — the consolidated checklist the RFC's owners use to
   decide "done-ness."
7. **References** — links to upstream RFCs, framework docs, prior
   tickets, and any spec-kit specs that motivated the work.

Replace each placeholder (`<question>`, `<one-line summary>`, etc.) as
you draft. Treat the template as a starting outline — sections that
don't apply can be deleted, sections you need can be added.

> **Tip:** if you're using Claude Code, you can ask the assistant to
> populate the body from a spoken brief. The agent will respect the
> template's section ordering and avoid touching the scaffold notice
> at the top.

---

## Step 4 — Resolve Open Questions

Open Questions are the engine of the RFC process. They surface the
points where the design hasn't converged. The framework supports two
disciplined resolution paths:

### Path A — resolve in the RFC body

For decisions the RFC's owners can make directly, add a
`**Resolution:**` marker under each OQ in the **Decisions** section.
This is the durable narrative — months later, a contributor reading
the RFC sees both the question and the chosen answer.

```markdown
## Decisions

- **OQ-1 — Should tenant boundaries enforce at the database or
  application layer?**
  **Resolution:** Database (Postgres row-level security).
  **Rationale:** Defence in depth; app-layer enforcement has historically
  drifted out of sync with policy changes.
  **Trade-offs:** ~5% query overhead; tighter coupling to Postgres.
```

> **Important:** the framework's DoR Gate considers an Open Question
> unresolved unless it has a `**Resolution:**` (or `RESOLVED:` / `✅
> RESOLVED`) marker. If a backlog task references your RFC and one of
> the OQs is still open, the DoR upstream-OQ gate will **block
> dispatch** of that task. This is the design — see Step 5.

### Path B — route through the Decision Catalog (RFC-0035)

For decisions that need cross-team routing (Engineering / Product /
Operator), file the OQ as a `Decision` in the RFC-0035 Decision
Catalog. The catalog routes it to the appropriate actor, captures the
deliberation, and (once answered) lets you fold the resolution back
into the RFC body.

```bash
node pipeline-cli/bin/cli-decisions.mjs add \
  --summary "Tenant boundary enforcement layer (RFC-multi-tenancy-model OQ-1)" \
  --scope "rfc:multi-tenancy-model" \
  --option "db:Postgres row-level security" \
  --option "app:Application-layer policy guards"
```

You can list which decisions are scoped to your RFC at any time with
`ai-sdlc rfc index` (Phase 9 / AISDLC-334) — the index cross-references
your adopter RFCs against the Decision Catalog and reports per-RFC
counts of resolved vs. pending decisions.

---

## Step 5 — Cross-link from backlog tasks

When you create backlog tasks that implement your RFC, add the RFC
file path to the task's `references:` frontmatter array:

```yaml
references:
  - rfcs/multi-tenancy-model.md
```

This wires three things automatically:

1. The **backlog-drift gate** verifies the reference resolves on every
   commit / push.
2. The **DoR upstream-OQ gate** scans the referenced RFC for unresolved
   Open Questions and **blocks task dispatch** if any remain. This is
   the framework's mechanism for preventing implementation from racing
   ahead of design.
3. The **upstream-OQ override** lets the operator unblock a task before
   all OQs are answered by adding `blocked.reason:` to the task
   frontmatter — every override is logged for audit.

The result is a clean separation: the RFC carries the decision; the
task carries the deliverable; the gate keeps them honest.

---

## Step 6 — Promote the lifecycle

The adopter RFC scaffold deliberately omits formal lifecycle
ceremonies — no required sign-off, no registry numbering. The
recommended (but not enforced) progression is:

- **Draft** — being written; sections may shift; placeholders not yet
  replaced.
- **Ready for Review** — body is stable; Open Questions captured;
  shared with the team for feedback.
- **Decided** — Open Questions all have `**Resolution:**` markers;
  Phases are scoped; team consensus reached.
- **Implemented** — all Phases have shipped (the backlog tasks they
  spawned are all in `backlog/completed/`).

Promote by updating the `**Status:**` line at the top of the file.
There's no gate; this is signalling for human readers.

---

## Worked example: a multi-tenancy RFC

A small team is adding multi-tenancy to a hosted product. The decision
spans data layout, policy enforcement, deployment topology, and
billing-event attribution. Three different engineers will own
different phases. This is exactly the kind of decision that benefits
from an RFC.

```bash
ai-sdlc rfc init multi-tenancy-model \
  --title "Multi-Tenancy Model" \
  --author "Acme Eng"
```

The scaffold lands at `rfcs/multi-tenancy-model.md`. The team:

1. Fills out **Summary** and **Background** in the first 30 minutes.
2. Lists 5 Open Questions (data layout, policy layer, ID generation,
   billing attribution, migration strategy).
3. Resolves three of the five in-body. Routes the remaining two
   (billing attribution + migration strategy) through the Decision
   Catalog because they need Product's input.
4. Breaks implementation into 4 Phases. For each phase, the engineer
   who owns it files a backlog task that references
   `rfcs/multi-tenancy-model.md` and includes the phase's ACs.
5. As tasks ship, the team marks Phases complete in the RFC and
   eventually promotes the lifecycle to **Decided**.
6. Months later, an auditor reads the RFC and understands exactly why
   tenant boundaries enforce at the database layer, what alternatives
   were considered, and why two follow-up Decisions were routed
   through the Catalog.

The RFC was the right artifact because the decision was cross-cutting
(four areas), had multiple viable options (each OQ had at least two),
and will be referenced by future contributors.

---

## Configuration reference (`.ai-sdlc/adopter-authoring.yaml`)

The full per-org schema is documented in
[RFC-0036 §14.1](../../spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md#141-configuration-schema-per-org-defaults).
The slice that affects the scaffold:

```yaml
adopter-authoring:
  rfc-scaffold:
    rfcDir: rfcs/                     # OQ-4 — where `ai-sdlc rfc init` writes
                                      # Multi-repo adopters override:
                                      # rfcDir: ../company-rfcs/

  rfc-templates:                      # OQ-5 — one template in v1
    defaultTemplate: framework-rfc.md
```

All fields are optional and default to the values shown. A repo with
no `adopter-authoring.yaml` works against these defaults; create the
file only when you need to override.

---

## Why these defaults? — design rationale and RFC-0036 OQ resolutions

| Default | OQ | Rationale |
|---|---|---|
| Writes to `rfcs/<slug>.md` by default | OQ-4 | Per-org config schema established across RFC-0024 / 0025 / 0031 / 0035 / 0022. Single-repo adopters need zero config; multi-repo adopters override the directory. |
| One template (`framework-rfc.md`) | OQ-5 | Cognitive load < flexibility for v1. Demand for variants (architecture / product-decision / retrospective) becomes a future Decision in the Catalog when adopter signal justifies the split. |
| Dual surface (`cli-rfc init` + `/ai-sdlc rfc-init`) | OQ-12 | Established framework convention. Both surfaces shell out to the same binary, so there is one source of truth for validation + rendering. |
| Slug validation (lowercase, no path traversal) | — | Defence-in-depth filesystem safety; pre-empts the surprising-output category of bug where a `--slug ../../../etc/passwd` would otherwise reach the writer. |
| Refuses to overwrite by default | — | The scaffold is for drafting; the operator should explicitly opt into `--force` if they actually intend to replace content. Matches the broader framework convention (e.g. `cli-import-spec` never silent-overwrites). |
| Template is lightweight (no frontmatter / sign-off / registry) | RFC-0036 §7.3 | The internal RFC process is heavyweight by design and inappropriate for adopter day-to-day work. The scaffold is offered, not prescribed. |

---

## Further reading

- [RFC-0036](../../spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md) — normative spec for adopter authoring (this tutorial implements Phase 2)
- [`docs/concepts/spec-driven.md`](../concepts/spec-driven.md) — three-tier authoring model (RFC → Spec → Task)
- [Tutorial 10 — Spec-Kit Bridge](./10-spec-kit-bridge.md) — front-of-funnel companion (spec-kit → backlog tasks)
- [RFC-0011](../../spec/rfcs/RFC-0011-definition-of-ready-gate.md) — DoR Gate (the quality contract; consumes RFC references via the upstream-OQ gate)
- [RFC-0035](../../spec/rfcs/RFC-0035-decision-catalog-operator-routing.md) — Decision Catalog (operator-routing surface; consumes adopter RFC OQs via `cli-rfc index`)
- [`spec/rfcs/README.md`](../../spec/rfcs/README.md) — framework's own internal RFC process (for contrast with this adopter-altitude scaffold)
