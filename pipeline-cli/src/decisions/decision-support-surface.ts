/**
 * RFC-0035 Phase 6 — Decision support surface renderer (AISDLC-290).
 *
 * Renders the full §8 *Decision view* for a single Decision: problem +
 * options + recommendation + counter-arguments + sub-decision graph +
 * Stage A/B/C verdict provenance.
 *
 * The surface composes existing data (no new persistence). All inputs are
 * already present on the materialized `Decision` (per the projection):
 *
 *   - `spec.summary` + `spec.body` + `spec.options`             → problem + options
 *   - `status.evaluation.stageC.recommendation`                  → recommendation
 *   - `status.evaluation.stageC.counterArguments`                → counter-arguments (§8.1)
 *   - `spec.options[].subDecisions` ∪ `stageC.subDecisionsImplied`
 *                                                                → sub-decision graph (§8.1)
 *   - `status.evaluation.{stageA,stageB,stageC}` (+ tier/by markers)
 *                                                                → Stage A/B/C verdict provenance
 *
 * The renderer is **backward-compatible** (AC#5): when a Decision has no
 * Stage B/C output yet, the recommendation / counter-arguments / Stage B-C
 * provenance sections are skipped silently; Mermaid output renders only the
 * sub-decision sections that have content; an empty graph is suppressed.
 *
 * The output is a Markdown-compatible text body (Mermaid fences for the
 * graph, prose-style headings for the rest) so the same renderer feeds:
 *
 *   - `cli-decisions show <id>` (text mode) — primary surface (AC#3)
 *   - Future RFC-0023 TUI decisions-pending pane — drop into the existing
 *     Ink text-output, Mermaid fences degrade to indented text outlines.
 *   - Future web operator surface — Mermaid renders natively.
 *
 * @module decisions/decision-support-surface
 */

import type {
  Decision,
  StageAOutput,
  StageBOutput,
  StageCOutput,
  StageCSubDecisionImplied,
} from './decision-record.js';

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * One row in the sub-decision graph. The graph is a forest (one root per
 * declared option). The root row carries the option label; child rows are
 * the sub-decision questions either declared on the option or surfaced by
 * Stage C as implied follow-ups.
 */
export interface SubDecisionGraphNode {
  /** Owning option id (e.g. `opt-a`). */
  optionId: string;
  /** Option description (set on the root only). */
  optionDescription: string;
  /** Children — sub-decision questions for this option. */
  subDecisions: Array<{
    /** The question text (one line). */
    text: string;
    /** `declared` = author-supplied; `implied` = Stage C surfaced. */
    source: 'declared' | 'implied';
  }>;
}

/**
 * Structured view of the support surface — useful for unit tests + future
 * non-text consumers (TUI, web). Markdown rendering is a pure projection
 * over this view.
 */
export interface DecisionSupportView {
  decisionId: string;
  /** `spec.summary` (always present). */
  problemSummary: string;
  /** `spec.body` (optional — undefined when not authored). */
  problemBody?: string;
  /** Each option with its consequences + sub-decisions counts. */
  options: Array<{
    id: string;
    description: string;
    consequences: string[];
    dependents: string[];
    declaredSubDecisions: string[];
  }>;
  /**
   * The framework's recommendation (from Stage C). Absent when Stage C has
   * not produced a recommendation yet (Phase 1-5 decision in the catalog,
   * or pre-Stage-C in the lifecycle).
   */
  recommendation?: {
    optionId: string;
    confidence: number;
    rationale: string;
    /** `auto-applied` when the framework already fired; `pending-operator` otherwise. */
    status: 'auto-applied' | 'pending-operator';
  };
  /** Steel-manned objections (Stage C `counterArguments`). Empty when absent. */
  counterArguments: string[];
  /** Each option's declared + Stage C-implied sub-decisions, normalized into a forest. */
  subDecisionGraph: SubDecisionGraphNode[];
  /** Stage A audit summary. Absent when Stage A has not run. */
  stageAProvenance?: {
    prioritySignal: number;
    resolvedByStageA: boolean;
    routingActor: string | null;
    reversibility: StageAOutput['reversibility'];
    blastRadius: StageAOutput['blastRadius'];
  };
  /** Stage B audit summary. Absent when Stage B has not run. */
  stageBProvenance?: {
    compositeScore: number;
    resolvedByStageB: boolean;
    primaryActor: string;
    subActors: string[];
    rationale: string;
    llmEligible: boolean;
  };
  /** Stage C audit summary. Absent when Stage C has not run. */
  stageCProvenance?: {
    recommendationOptionId: string;
    confidence: number;
    effectiveThreshold: number;
    metBehindThreshold: boolean;
    llmAnswerEligible: boolean;
    model: string;
    error?: string;
    autoApplyAt?: string | null;
    overrideWindowHours?: number;
  };
}

// ── Construction ─────────────────────────────────────────────────────────────

/**
 * Project a `Decision` into the structured support view.
 *
 * Pure function — no I/O, no exceptions on missing-evaluation fields. AC#5
 * backward-compat is realised here: every Stage-X provenance block is gated
 * on the corresponding `status.evaluation.stageX` being present.
 */
export function buildDecisionSupportView(decision: Decision): DecisionSupportView {
  const evaluation = (decision.status.evaluation ?? {}) as {
    stageA?: StageAOutput;
    stageB?: StageBOutput;
    stageC?: StageCOutput;
  };

  const view: DecisionSupportView = {
    decisionId: decision.metadata.id,
    problemSummary: decision.spec.summary,
    ...(decision.spec.body ? { problemBody: decision.spec.body } : {}),
    options: decision.spec.options.map((opt) => ({
      id: opt.id,
      description: opt.description,
      consequences: opt.consequences ?? [],
      dependents: opt.dependents ?? [],
      declaredSubDecisions: opt.subDecisions ?? [],
    })),
    counterArguments: evaluation.stageC?.counterArguments ?? [],
    subDecisionGraph: buildSubDecisionGraph(decision, evaluation.stageC),
  };

  // Recommendation (Stage C) — only when present + decision still open OR
  // when answered by framework (the recommendation IS the auto-applied answer).
  if (evaluation.stageC?.recommendation) {
    const rec = evaluation.stageC.recommendation;
    // A decision is auto-applied when the recommendation IS the answer and the
    // answeredBy is the framework. Otherwise it's a pending operator surface.
    const isAutoApplied =
      decision.status.lifecycle === 'answered' &&
      decision.status.answeredOptionId === rec.optionId &&
      decision.status.answeredBy === 'framework';
    view.recommendation = {
      optionId: rec.optionId,
      confidence: rec.confidence,
      rationale: rec.rationale,
      status: isAutoApplied ? 'auto-applied' : 'pending-operator',
    };
  }

  if (evaluation.stageA) {
    const a = evaluation.stageA;
    view.stageAProvenance = {
      prioritySignal: a.prioritySignal,
      resolvedByStageA: a.resolvedByStageA,
      routingActor: a.routingActor,
      reversibility: a.reversibility,
      blastRadius: a.blastRadius,
    };
  }

  if (evaluation.stageB) {
    const b = evaluation.stageB;
    view.stageBProvenance = {
      compositeScore: b.compositeScore,
      resolvedByStageB: b.resolvedByStageB,
      primaryActor: b.routing.primaryActor,
      subActors: b.routing.subActors,
      rationale: b.routing.rationale,
      llmEligible: b.routing.llmEligible,
    };
  }

  if (evaluation.stageC) {
    const c = evaluation.stageC;
    view.stageCProvenance = {
      recommendationOptionId: c.recommendation.optionId,
      confidence: c.recommendation.confidence,
      effectiveThreshold: c.effectiveThreshold,
      metBehindThreshold: c.metBehindThreshold,
      llmAnswerEligible: c.llmAnswerEligible,
      model: c.model,
      ...(c.error !== undefined ? { error: c.error } : {}),
      ...(c.autoApplyAt !== undefined ? { autoApplyAt: c.autoApplyAt } : {}),
      ...(c.overrideWindowHours !== undefined
        ? { overrideWindowHours: c.overrideWindowHours }
        : {}),
    };
  }

  return view;
}

/**
 * Build the sub-decision graph forest. Each declared option becomes a root
 * node; its children are the union of the option's declared `subDecisions`
 * and Stage C-implied `subDecisionsImplied[optionId === thisOption]`.
 *
 * Options without any sub-decisions are returned with an empty `subDecisions`
 * array — `renderSubDecisionGraphMermaid` decides whether to skip them in
 * the diagram or include them as leaf nodes (AC#5 backward-compat path).
 */
export function buildSubDecisionGraph(
  decision: Decision,
  stageC: StageCOutput | undefined,
): SubDecisionGraphNode[] {
  const impliedByOption = new Map<string, StageCSubDecisionImplied[]>();
  for (const sd of stageC?.subDecisionsImplied ?? []) {
    const existing = impliedByOption.get(sd.optionId) ?? [];
    existing.push(sd);
    impliedByOption.set(sd.optionId, existing);
  }

  return decision.spec.options.map<SubDecisionGraphNode>((opt) => {
    const declared = (opt.subDecisions ?? []).map((text) => ({
      text,
      source: 'declared' as const,
    }));
    const implied = (impliedByOption.get(opt.id) ?? []).map((sd) => ({
      text: sd.followUp,
      source: 'implied' as const,
    }));
    return {
      optionId: opt.id,
      optionDescription: opt.description,
      subDecisions: [...declared, ...implied],
    };
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render the support view as a Markdown-compatible text body. Sections are
 * suppressed when their underlying data is absent (AC#5).
 */
export function renderDecisionSupportSurface(view: DecisionSupportView): string {
  const lines: string[] = [];

  // -- Header (problem) ------------------------------------------------------
  lines.push(`## Problem`);
  lines.push('');
  lines.push(view.problemSummary);
  if (view.problemBody) {
    lines.push('');
    for (const ln of view.problemBody.split('\n')) lines.push(ln);
  }

  // -- Options ---------------------------------------------------------------
  lines.push('');
  lines.push('## Options');
  lines.push('');
  for (const opt of view.options) {
    lines.push(`- **${opt.id}** — ${opt.description}`);
    for (const c of opt.consequences) {
      lines.push(`  - consequence: ${c}`);
    }
    for (const d of opt.dependents) {
      lines.push(`  - dependent: ${d}`);
    }
  }

  // -- Recommendation --------------------------------------------------------
  if (view.recommendation) {
    const r = view.recommendation;
    lines.push('');
    lines.push('## Recommendation');
    lines.push('');
    lines.push(`- **option:** ${r.optionId}`);
    lines.push(`- **confidence:** ${r.confidence.toFixed(3)}`);
    lines.push(`- **status:** ${r.status}`);
    lines.push(`- **rationale:** ${r.rationale}`);
  }

  // -- Counter-arguments (only when Stage C produced any) --------------------
  if (view.counterArguments.length > 0) {
    lines.push('');
    lines.push('## Counter-arguments');
    lines.push('');
    for (const ca of view.counterArguments) {
      lines.push(`- ${ca}`);
    }
  }

  // -- Sub-decision graph (Mermaid + text outline fallback) ------------------
  const mermaid = renderSubDecisionGraphMermaid(view.subDecisionGraph, view.decisionId);
  if (mermaid !== null) {
    lines.push('');
    lines.push('## Sub-decision graph');
    lines.push('');
    lines.push('```mermaid');
    lines.push(mermaid);
    lines.push('```');
    lines.push('');
    // Text outline fallback so TUI consumers (no Mermaid renderer) still
    // see the structure. Each option that has sub-decisions becomes a
    // bullet group; options without sub-decisions are omitted from the
    // outline to keep it tight (AC#5).
    lines.push('Text outline (TUI fallback):');
    for (const node of view.subDecisionGraph) {
      if (node.subDecisions.length === 0) continue;
      lines.push(`- ${node.optionId}: ${node.optionDescription}`);
      for (const sd of node.subDecisions) {
        const tag = sd.source === 'implied' ? ' [implied]' : '';
        lines.push(`  - ${sd.text}${tag}`);
      }
    }
  }

  // -- Stage A/B/C provenance (always last; collapsible-feel) ----------------
  const provenance = renderStageProvenance(view);
  if (provenance.length > 0) {
    lines.push('');
    lines.push('## Verdict provenance');
    lines.push('');
    for (const ln of provenance) lines.push(ln);
  }

  return lines.join('\n') + '\n';
}

/**
 * Render the sub-decision graph as a Mermaid `flowchart TD` diagram. Returns
 * `null` when the graph has no nodes worth rendering (AC#5: backward-compat
 * — decisions without any declared or implied sub-decisions get no diagram).
 *
 * Mermaid quoting: option descriptions and sub-decision text are placed in
 * `["..."]` quoted labels to handle commas, colons, parens, etc. Internal
 * `"` are escaped to `&quot;` (Mermaid's documented escape).
 */
export function renderSubDecisionGraphMermaid(
  graph: SubDecisionGraphNode[],
  decisionId: string,
): string | null {
  const hasContent = graph.some((n) => n.subDecisions.length > 0);
  if (!hasContent) return null;

  const lines: string[] = ['flowchart TD'];
  const rootId = `D[${quoteMermaidLabel(decisionId)}]`;
  lines.push(`  ${rootId}`);

  for (let i = 0; i < graph.length; i += 1) {
    const node = graph[i];
    if (node.subDecisions.length === 0) {
      // Skip options without sub-decisions to keep the diagram clean (AC#5).
      continue;
    }
    const optNodeId = `O${i}`;
    lines.push(
      `  ${optNodeId}[${quoteMermaidLabel(`${node.optionId}: ${node.optionDescription}`)}]`,
    );
    lines.push(`  D --> ${optNodeId}`);
    for (let j = 0; j < node.subDecisions.length; j += 1) {
      const sd = node.subDecisions[j];
      const sdNodeId = `O${i}S${j}`;
      const tag = sd.source === 'implied' ? '? ' : '';
      lines.push(`  ${sdNodeId}[${quoteMermaidLabel(`${tag}${sd.text}`)}]`);
      lines.push(`  ${optNodeId} --> ${sdNodeId}`);
    }
  }

  return lines.join('\n');
}

function quoteMermaidLabel(text: string): string {
  // Mermaid recommends `&quot;` for embedded double quotes inside `["..."]`.
  return `"${text.replace(/"/g, '&quot;')}"`;
}

// ── Phase 10 (AISDLC-294) — Richer HTML graph rendering ─────────────────────

/**
 * Render the sub-decision graph as a standalone HTML document that ships
 * the Mermaid renderer (CDN) so operators can open it directly in a
 * browser without a local toolchain. The HTML escapes Mermaid metachars
 * via the existing `renderSubDecisionGraphMermaid()` quoting; the wrapper
 * only adds the doc shell + `<script type="module">` boot.
 *
 * Returns `null` when the underlying graph has nothing worth rendering
 * (mirrors `renderSubDecisionGraphMermaid`'s contract).
 *
 * This is the §8.2 "richer rendering" surface — the operator can pipe it
 * to a file (`> /tmp/dec-0042.html`) and open it directly. Future work
 * may replace the CDN dependency with a bundled `mermaid.min.js` for
 * offline use; v1 ships the CDN form because the cost is one script tag
 * and the surface is operator-side, not subagent-side (no sandbox).
 */
export function renderSubDecisionGraphHtml(
  graph: SubDecisionGraphNode[],
  decisionId: string,
): string | null {
  const mermaid = renderSubDecisionGraphMermaid(graph, decisionId);
  if (mermaid === null) return null;

  // HTML-escape the embedded Mermaid source. Mermaid's own quoting is
  // already done inside `quoteMermaidLabel`; we only need to defend
  // against `</script>` injection in option text (paranoid but cheap).
  const escapedMermaid = escapeForScript(mermaid);
  const escapedTitle = escapeHtml(`Decision ${decisionId} — sub-decision graph`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapedTitle}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           max-width: 1200px; margin: 2em auto; padding: 0 1em; color: #1d1d1f; }
    h1 { font-size: 1.4em; margin-bottom: 0.5em; }
    .mermaid { background: #fafafa; border: 1px solid #e1e4e8; border-radius: 6px;
               padding: 1.5em; overflow-x: auto; }
    footer { margin-top: 2em; color: #6e6e73; font-size: 0.85em; }
  </style>
</head>
<body>
  <h1>${escapedTitle}</h1>
  <div class="mermaid">${escapedMermaid}</div>
  <footer>
    Rendered by <code>cli-decisions graph &lt;id&gt; --format html</code> (RFC-0035 Phase 10).
  </footer>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: true, theme: "default" });
  </script>
</body>
</html>
`;
}

/**
 * Escape characters that would break out of an HTML element body. Used
 * for the page title; the Mermaid block uses {@link escapeForScript}.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape characters that would let raw Mermaid source break out of a
 * `<div class="mermaid">` block AND defend against `</script>` injection
 * if a malicious option label ever contained it. Mermaid itself parses
 * the inner text — we just need to keep HTML / script boundaries clean.
 */
function escapeForScript(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render the Stage A / B / C provenance block as Markdown bullet lines.
 * Each tier is rendered independently — operators see "which tier resolved
 * it, with what signals" (AC#4).
 */
export function renderStageProvenance(view: DecisionSupportView): string[] {
  const lines: string[] = [];

  if (view.stageAProvenance) {
    const a = view.stageAProvenance;
    lines.push('### Stage A (deterministic checks)');
    lines.push(`- priority signal: ${a.prioritySignal.toFixed(3)}`);
    lines.push(`- resolved by Stage A: ${a.resolvedByStageA ? 'yes' : 'no'}`);
    lines.push(`- routing actor: ${a.routingActor ?? '(needs Stage B)'}`);
    lines.push(`- reversibility: ${a.reversibility}`);
    lines.push(
      `- blast radius: tasks=${a.blastRadius.blockedTaskCount}, rfcs=${a.blastRadius.blockedRfcCount}, pillars=[${a.blastRadius.affectedPillars.join(', ')}]`,
    );
  }

  if (view.stageBProvenance) {
    if (lines.length > 0) lines.push('');
    const b = view.stageBProvenance;
    lines.push('### Stage B (structural rubrics)');
    lines.push(`- composite score: ${b.compositeScore.toFixed(3)}`);
    lines.push(`- resolved by Stage B: ${b.resolvedByStageB ? 'yes' : 'no'}`);
    lines.push(`- primary actor: ${b.primaryActor}`);
    if (b.subActors.length > 0) {
      lines.push(`- sub-actors: ${b.subActors.join(', ')}`);
    }
    lines.push(`- llm-eligible: ${b.llmEligible ? 'yes' : 'no'}`);
    lines.push(`- rationale: ${b.rationale}`);
  }

  if (view.stageCProvenance) {
    if (lines.length > 0) lines.push('');
    const c = view.stageCProvenance;
    lines.push('### Stage C (LLM evaluation)');
    lines.push(`- recommendation: ${c.recommendationOptionId}`);
    lines.push(`- confidence: ${c.confidence.toFixed(3)}`);
    lines.push(`- threshold: ${c.effectiveThreshold.toFixed(3)}`);
    lines.push(`- met threshold: ${c.metBehindThreshold ? 'yes' : 'no'}`);
    lines.push(`- llm-answer eligible: ${c.llmAnswerEligible ? 'yes' : 'no'}`);
    lines.push(`- model: ${c.model}`);
    if (c.error) lines.push(`- error: ${c.error}`);
    if (c.autoApplyAt) {
      lines.push(`- auto-applied at: ${c.autoApplyAt}`);
      if (c.overrideWindowHours !== undefined) {
        lines.push(`- override window: ${c.overrideWindowHours}h`);
      }
    }
  }

  return lines;
}
