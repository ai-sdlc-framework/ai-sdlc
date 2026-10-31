---
name: workflow-graph-audit-2026-10-18
description: Operator asked for the ai-sdlc workflow drawn as a graph, audited, and a composable-config proposal; published as an artifact 2026-10-18 with 16 findings and a 4-phase Workflow-kind plan
metadata:
  type: project
---

On 2026-10-18 the operator read the "Graph Engineering" article and asked for (1) the existing ai-sdlc workflow as a node/edge graph, (2) an audit, (3) a plan to express the graph in configuration. Delivered as https://claude.ai/artifact/WDYWRxGSnYUUn7cy8GphWZ (five SVG figures, 16 audit findings with file:line, Workflow-kind proposal).

Key conclusions not derivable from the code alone:
- Three stacked loops (hierarchy, execute pipeline, PR lifecycle); only the execute pipeline is a true pipeline. Operator's framing: ai-sdlc = static topology, Claude Workflow tool = dynamic topology in one session. Agreed direction: static topology, dynamic width inside caps.
- Highest-value findings: three orchestrators over one step library (composite path still arms auto-merge with the raw gh command, `execute-pipeline.ts:600-613`); staged review runs beside the classic set and both block (DEC-0149 vs RFC-0052 "shadow"); step 6 trusts the developer's self-reported verifications; pr-lifecycle.yaml and pipeline.yaml spec.stages are mostly unread ("config that lies"); dispatch and executor sessions are LLM loops around deterministic CLI calls.
- Proposed migration: (1) derive the graph from the step modules via a `cli-workflow graph` command, (2) add a `Workflow` kind + manifest entry, (3) engine behind a flag with golden replay test, (4) open knobs with `frozen` nodes needing a DEC id.

**Why:** operator wants ai-sdlc composable for adopters (enterprise cost control) rather than opinionated hard-coding.

**How to apply:** when the operator returns to this theme, start from the artifact's audit table and phase 1 (derive, do not author). Do not re-trace the code; the five research notes lived in the session scratchpad and are gone, but the artifact carries the citations. Related: [[feedback_five_step_production_algorithm]], [[feedback_automation_ladder]], [[feedback_design_for_adopters_first]].
