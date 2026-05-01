/**
 * Stage B — LLM-backed semantic evaluator.
 *
 * RFC-0011 Phase 2b (AISDLC-115.3). Stage B owns the gates that need
 * semantic judgment Stage A can't make on its own:
 *   - Gates 4 (scope bounded) and 6 (done-state describable) ALWAYS
 *     return `verdict: 'skip'` from Stage A — Stage B is the sole owner
 *     of their final verdict.
 *   - Gates 1, 5 (and optionally others) escalate to Stage B when their
 *     deterministic check passes with `confidence < high` (e.g. gate 1
 *     has ACs but the LLM should judge whether they read as testable).
 *
 * The orchestrator:
 *   1. Picks the set of gates that need a Stage B verdict.
 *   2. Builds a single composite prompt asking the agent to score each
 *      gate as a binary yes/no with confidence + finding.
 *   3. Dispatches via the injected `SubagentSpawner` (subscription via
 *      `claude --print`, API key via SDK, or `MockSpawner` for tests).
 *   4. Parses the structured JSON response into a `Map<GateId,
 *      GateEvaluation>` carrying `stage: 'B'`.
 *
 * Per RFC §5.3 the agent runs read-only: tools = Read/Grep/Glob/Bash,
 * disallowedTools = Edit/Write/AgentTool. The plugin agent file at
 * `ai-sdlc-plugin/agents/refinement-reviewer.md` carries the prompt
 * skeleton and tool restrictions.
 */

import type { SubagentResult, SubagentSpawner, SpawnOpts } from '../types.js';
import type {
  GateConfidence,
  GateEvaluation,
  GateId,
  GateVerdict,
  IssueInput,
  StageAVerdict,
} from './types.js';

/**
 * Gates Stage B always owns — return verdict 'skip' from Stage A by
 * design (RFC §4.4 — gates 4 + 6 are fully Stage B).
 */
export const STAGE_B_OWNED_GATES: readonly GateId[] = [4, 6] as const;

/**
 * Per-gate prompt fragments. The composite prompt sent to the agent
 * embeds these so the model knows what each binary yes/no means.
 *
 * RFC §4.1 + §4.4 — the rubric. The phrasing here is deliberately
 * binary — "is X true?" — to push the LLM toward yes/no rather than
 * essay-style answers.
 */
export const STAGE_B_GATE_QUESTIONS: Record<GateId, string> = {
  1: 'Are ALL acceptance criteria phrased so a reviewer can binary-test pass/fail without subjective judgment? (yes = every AC has a clear, observable post-condition; no = one or more reads as vague / aspirational / "improve X" without a metric).',
  2: 'Stage A already verified there are no placeholder tokens (TBD/TODO/etc.). Are there ALSO no semantic placeholders disguised as commitments — e.g. "we will choose later", phrasings that defer a decision the issue claims to make? (yes = no hidden placeholders; no = author left a decision unresolved in prose).',
  3: 'Beyond the named-thing references Stage A checked, are there any bare references ("like the dashboard PR", "per Alex\'s spec") that should be linked but aren\'t? (yes = no unlinked bare references; no = bare reference present that needs a concrete link).',
  4: 'Does this issue fit in ONE pull request — bounded scope, single coherent change, not a multi-PR rewrite? (yes = fits one PR; no = should be split into multiple issues).',
  5: 'Is the named affected surface SPECIFIC enough to be actionable — a concrete file path / route / component, not "the search system" or "the dashboard" in general? (yes = specific surface; no = surface name is too broad / too vague).',
  6: 'Can a reviewer describe the user-visible end state from the issue body alone? (yes = done-state is describable from AC + description; no = the issue describes process or investigation but not a concrete deliverable).',
  7: 'Are there ANY structural assumptions or unstated dependencies the author is relying on that would block another developer from picking this up cold? (yes = no invisible deps; no = the issue assumes context the body does not surface).',
};

export interface StageBOpts {
  /** Spawner that dispatches the LLM call. Required. */
  spawner: SubagentSpawner;
  /** Project root the agent reads files from. Defaults to `input.workDir ?? process.cwd()`. */
  cwd?: string;
  /** Per-spawn timeout in ms. Forwarded to the spawner. */
  timeoutMs?: number;
  /**
   * Override the gate set Stage B evaluates. Defaults to the union of
   * `STAGE_B_OWNED_GATES` (always 4 + 6) and any Stage A gate that
   * passed with confidence other than 'high'.
   */
  gates?: readonly GateId[];
  /** Override evaluator version stamp (used by snapshots). */
  evaluatorVersion?: string;
}

export const STAGE_B_EVALUATOR_VERSION = 'stage-b-2026.05.01';

/**
 * Per-gate verdict the LLM is expected to emit. Schema enforced when
 * parsing — invalid shapes default to 'skip' with low confidence so
 * the orchestrator can escalate.
 */
export interface StageBGateResponse {
  gateId: GateId;
  verdict: GateVerdict;
  confidence: GateConfidence;
  finding?: string;
  clarificationQuestion?: string;
}

export interface StageBResponse {
  /** Per-gate verdicts. Order is not significant; orchestrator indexes by gateId. */
  gates: StageBGateResponse[];
  /** Optional aggregate summary the agent provides. */
  summary?: string;
}

/**
 * Result of running Stage B against an issue. Carries:
 *   - `gateEvaluations` — per-gate `GateEvaluation` (stage='B') keyed for
 *     easy merging with Stage A.
 *   - `summary` — optional aggregate string the agent emitted.
 *   - `raw` — the underlying SubagentResult for debugging / calibration.
 */
export interface StageBResult {
  gateEvaluations: Map<GateId, GateEvaluation>;
  summary?: string;
  raw: SubagentResult;
}

/**
 * Pick the gates Stage B should evaluate, given a Stage A verdict.
 *
 *   - Always include `STAGE_B_OWNED_GATES` (4, 6).
 *   - Include any Stage A gate whose verdict was 'pass' with confidence
 *     'low' or 'medium' — these are the "Stage A is OK but Stage B
 *     should second-guess" cases.
 *   - Skip gates Stage A blocked on (severity='block', verdict='fail')
 *     because the orchestrator already has a definitive verdict.
 */
export function pickStageBGates(stageA: StageAVerdict): GateId[] {
  const out = new Set<GateId>(STAGE_B_OWNED_GATES);
  for (const g of stageA.gates) {
    if (g.verdict === 'pass' && g.confidence !== 'high') {
      out.add(g.gateId);
    }
  }
  // Sort for deterministic prompt ordering
  return [...out].sort((a, b) => a - b);
}

/**
 * Build the composite prompt sent to the refinement-reviewer agent.
 * The prompt is deliberately structured: title + body + Stage A summary
 * + per-gate yes/no questions + a strict JSON output spec.
 */
export function buildStageBPrompt(
  input: IssueInput,
  stageA: StageAVerdict,
  gateIds: readonly GateId[],
): string {
  const gateBlocks = gateIds
    .map(
      (id) =>
        `### Gate ${id}\n${STAGE_B_GATE_QUESTIONS[id]}\nStage A finding: ${
          stageA.gates.find((g) => g.gateId === id)?.finding ?? '(none)'
        }`,
    )
    .join('\n\n');

  return `You are the AI-SDLC refinement-reviewer (Stage B). Your job is to score the listed Definition-of-Ready gates against an issue body using semantic judgment.

## Issue under review

**ID:** ${input.id}
**Title:** ${input.title}

\`\`\`markdown
${input.body}
\`\`\`

## Stage A verdict (deterministic)

Overall: \`${stageA.overallVerdict}\` (confidence: ${stageA.overallConfidence ?? 'medium'})
${stageA.summary ?? '(no summary)'}

## Stage B gates to score

For EACH gate below, return a binary yes/no verdict with confidence (high|medium|low) and a one-sentence finding.

${gateBlocks}

## Confidence tiering

- **high** — the body unambiguously meets / fails the bar
- **medium** — defensible verdict but a calibration spot-check would help
- **low** — genuinely ambiguous; downstream will escalate to a human triager

## Output

Return ONLY a JSON object in this exact shape (no prose, no markdown fence):

\`\`\`json
{
  "gates": [
    {
      "gateId": 4,
      "verdict": "pass" | "fail",
      "confidence": "high" | "medium" | "low",
      "finding": "one-sentence reason",
      "clarificationQuestion": "single question to post to the author (omit when verdict='pass')"
    }
  ],
  "summary": "optional one-sentence aggregate"
}
\`\`\`

Rules:
- "verdict": "pass" means the gate's question above is answered "yes". "fail" means "no".
- Include EVERY gate ID listed above; do not invent gate IDs.
- "finding" is required (one sentence). "clarificationQuestion" is required when verdict='fail'.
- Output JSON ONLY. No prose before or after.`;
}

/**
 * Parse the agent's structured JSON response. Tolerates:
 *   - Top-level JSON
 *   - JSON wrapped in a single \`\`\`json fence
 *   - Whitespace / newlines around the payload
 *
 * Returns null on parse failure — the orchestrator treats parse failure
 * as "Stage B couldn't decide", emits a 'skip' for each requested gate,
 * and downgrades aggregate confidence to 'low' so the verdict escalates.
 */
export function parseStageBResponse(raw: string): StageBResponse | null {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  // Strip a single ```json ... ``` (or ``` ... ```) fence if present.
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fence) text = fence[1].trim();
  try {
    const obj = JSON.parse(text) as unknown;
    if (!isStageBResponse(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

function isStageBResponse(obj: unknown): obj is StageBResponse {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.gates)) return false;
  for (const g of o.gates) {
    if (!g || typeof g !== 'object') return false;
    const gg = g as Record<string, unknown>;
    if (typeof gg.gateId !== 'number') return false;
    if (gg.gateId < 1 || gg.gateId > 7) return false;
    if (gg.verdict !== 'pass' && gg.verdict !== 'fail' && gg.verdict !== 'skip') return false;
    if (gg.confidence !== 'high' && gg.confidence !== 'medium' && gg.confidence !== 'low')
      return false;
  }
  return true;
}

/**
 * Run Stage B against an issue, given the Stage A verdict.
 *
 * Returns per-gate `GateEvaluation` objects (stage='B') indexed by
 * gateId so the orchestrator can merge with Stage A's per-gate verdicts.
 * On spawner error or parse failure, emits 'skip' verdicts with low
 * confidence so the composite logic downgrades the aggregate verdict
 * appropriately.
 */
export async function evaluateStageB(
  input: IssueInput,
  stageA: StageAVerdict,
  opts: StageBOpts,
): Promise<StageBResult> {
  const gateIds = opts.gates ?? pickStageBGates(stageA);
  const prompt = buildStageBPrompt(input, stageA, gateIds);
  const cwd = opts.cwd ?? input.workDir ?? process.cwd();

  const spawnOpts: SpawnOpts = {
    type: 'refinement-reviewer',
    prompt,
    cwd,
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  };

  const raw = await opts.spawner.spawn(spawnOpts);

  // Build per-gate evaluations defaulting to "skip + low confidence" so
  // any gate the agent omitted (or any error path) gets safely escalated.
  const evaluations = new Map<GateId, GateEvaluation>();
  for (const id of gateIds) {
    evaluations.set(id, defaultStageBSkip(id));
  }

  if (raw.status !== 'success' || !raw.output) {
    return { gateEvaluations: evaluations, raw };
  }

  const parsed = parseStageBResponse(raw.output);
  if (!parsed) {
    return { gateEvaluations: evaluations, raw };
  }

  for (const g of parsed.gates) {
    if (!gateIds.includes(g.gateId as GateId)) continue; // ignore stray gateIds
    evaluations.set(g.gateId as GateId, {
      gateId: g.gateId as GateId,
      verdict: g.verdict,
      confidence: g.confidence,
      severity: 'block',
      stage: 'B',
      finding: g.finding,
      clarificationQuestion: g.clarificationQuestion,
    });
  }

  return {
    gateEvaluations: evaluations,
    summary: parsed.summary,
    raw,
  };
}

function defaultStageBSkip(id: GateId): GateEvaluation {
  return {
    gateId: id,
    verdict: 'skip',
    confidence: 'low',
    severity: 'block',
    stage: 'B',
    finding: 'Stage B did not return a verdict for this gate; orchestrator must escalate.',
  };
}
