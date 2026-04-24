/**
 * Layer 3 — LLM structured assessment (RFC-0008 Addendum B §B.6).
 *
 * Builds SA-1 (domain-intent) and SA-2 (principle-alignment) prompts
 * with the Layer 1 preVerifiedSummary injected as a "CI-Boundary"
 * block — the LLM is explicitly told NOT to re-assess scope /
 * constraints / anti-patterns / signals (deterministically verified).
 * Parses structured JSON output and applies a confidence filter:
 * findings with `confidence < 0.5` are suppressed.
 *
 * Amendment 2 (v4 §5.2): the SA-2 prompt MUST NOT include
 * `tokenCompliance` or `catalogHealth` — those are covered by the C1
 * computable half of SA-2 and re-including them double-counts.
 */

import type { DesignIntentDocument, DesignSystemBinding } from '@ai-sdlc/reference';

// ── Dependencies ────────────────────────────────────────────────────

export interface LLMClient {
  complete(prompt: string): Promise<string>;
}

/** Deterministic fake for tests — no network calls. */
export class RecordedLLMClient implements LLMClient {
  private responseByPrompt: Map<string, string> = new Map();
  private fallbackResponse?: string;
  readonly promptLog: string[] = [];

  setResponse(promptSubstring: string, response: string): void {
    this.responseByPrompt.set(promptSubstring, response);
  }

  setFallbackResponse(response: string): void {
    this.fallbackResponse = response;
  }

  async complete(prompt: string): Promise<string> {
    this.promptLog.push(prompt);
    for (const [key, response] of this.responseByPrompt) {
      if (prompt.includes(key)) return response;
    }
    if (this.fallbackResponse !== undefined) return this.fallbackResponse;
    throw new Error('RecordedLLMClient: no response configured for this prompt');
  }
}

// ── Result shapes ───────────────────────────────────────────────────

export interface SubtleConflict {
  description: string;
  severity: 'low' | 'medium' | 'high';
  confidence: number;
}

export interface SubtleDesignConflict extends SubtleConflict {
  /** Principle this conflict relates to (optional). */
  principleId?: string;
}

export interface LLMScoringResult {
  /** SA-1 domain-intent score in [0, 1], 0 if below confidence filter. */
  domainIntent: number;
  domainIntentConfidence: number;
  subtleConflicts: SubtleConflict[];
  /** SA-2 principle-alignment score in [0, 1]. */
  principleAlignment: number;
  principleAlignmentConfidence: number;
  subtleDesignConflicts: SubtleDesignConflict[];
  /** Always true — signals the CI boundary block was applied. */
  preVerifiedBoundaryApplied: true;
  /** Count of findings dropped by the confidence filter (<0.5). */
  suppressedFindings: number;
}

// ── Errors ──────────────────────────────────────────────────────────

export type LayerLlmErrorKind = 'malformed-json' | 'missing-field' | 'invalid-range';

export class LayerLlmError extends Error {
  readonly kind: LayerLlmErrorKind;
  readonly raw?: string;

  constructor(kind: LayerLlmErrorKind, message: string, raw?: string) {
    super(message);
    this.name = 'LayerLlmError';
    this.kind = kind;
    this.raw = raw;
  }
}

// ── Constants ───────────────────────────────────────────────────────

export const CONFIDENCE_THRESHOLD = 0.5;
export const CI_BOUNDARY_HEADER = '## CI-Boundary: pre-verified (do not re-assess)';

/** Guidance line that MUST appear verbatim in both SA-1 and SA-2 prompts. */
export const SCOPE_GUIDANCE =
  'Do not re-assess scope, constraints, anti-patterns, or measurable signals — they have been deterministically verified above.';

// ── Prompt builders ─────────────────────────────────────────────────

export interface PromptContext {
  issueText: string;
  did: DesignIntentDocument;
  dsb?: DesignSystemBinding;
  preVerifiedSummary: string;
}

function renderDidSummarySa1(did: DesignIntentDocument): string {
  const mission = did.spec.soulPurpose.mission.value;
  const exp = did.spec.experientialTargets
    ? Object.entries(did.spec.experientialTargets)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
        .join('\n')
    : '';
  return [`**Mission:** ${mission}`, exp ? `\n**Experiential targets:**\n${exp}` : '']
    .join('')
    .trim();
}

/** SA-2 DID context — mission + principles ONLY. Excludes DSB status
 *  fields (tokenCompliance, catalogHealth) per Amendment 2. */
function renderDidSummarySa2(did: DesignIntentDocument): string {
  const principles = did.spec.soulPurpose.designPrinciples
    .map((p) => {
      const sigs = (p.measurableSignals ?? [])
        .map((s) => `  - signal: ${s.metric} ${s.operator} ${s.threshold}`)
        .join('\n');
      const identity = p.identityClass ? ` [${p.identityClass}]` : '';
      return `- **${p.name}**${identity} — ${p.description}${sigs ? `\n${sigs}` : ''}`;
    })
    .join('\n');
  return [
    `**Mission:** ${did.spec.soulPurpose.mission.value}`,
    '',
    '**Design principles:**',
    principles,
  ].join('\n');
}

export function buildSa1Prompt(ctx: PromptContext): string {
  return [
    '# SA-1 — Domain Intent Assessment',
    '',
    CI_BOUNDARY_HEADER,
    '',
    ctx.preVerifiedSummary,
    '',
    '---',
    '',
    SCOPE_GUIDANCE,
    '',
    '## Design Intent Document',
    '',
    renderDidSummarySa1(ctx.did),
    '',
    '## Issue text',
    '',
    ctx.issueText,
    '',
    '## Task',
    '',
    'Assess how well the issue aligns with the mission and experiential targets. ' +
      'Return ONLY the following JSON (no prose), with `confidence` in [0, 1]:',
    '',
    '```json',
    JSON.stringify(
      {
        domainIntent: 0.0,
        confidence: 0.0,
        subtleConflicts: [{ description: 'string', severity: 'low', confidence: 0.0 }],
      },
      null,
      2,
    ),
    '```',
  ].join('\n');
}

export function buildSa2Prompt(ctx: PromptContext): string {
  // Amendment 2: DSB status fields (tokenCompliance, catalogHealth) are
  // covered by the C1 computable half. The SA-2 prompt context
  // MUST NOT mention them, else the LLM's assessment double-counts.
  return [
    '# SA-2 — Principle Alignment Assessment',
    '',
    CI_BOUNDARY_HEADER,
    '',
    ctx.preVerifiedSummary,
    '',
    '---',
    '',
    SCOPE_GUIDANCE,
    '',
    '## Design principles to evaluate',
    '',
    renderDidSummarySa2(ctx.did),
    '',
    '## Issue text',
    '',
    ctx.issueText,
    '',
    '## Task',
    '',
    'Assess how well the issue embodies the listed design principles. ' +
      'Ignore DSB-level token compliance and catalog coverage — those are covered separately. ' +
      'Return ONLY the following JSON (no prose), with `confidence` in [0, 1]:',
    '',
    '```json',
    JSON.stringify(
      {
        principleAlignment: 0.0,
        confidence: 0.0,
        subtleDesignConflicts: [
          {
            description: 'string',
            severity: 'low',
            confidence: 0.0,
            principleId: 'string',
          },
        ],
      },
      null,
      2,
    ),
    '```',
  ].join('\n');
}

// ── Response parsing ────────────────────────────────────────────────

interface Sa1Raw {
  domainIntent: number;
  confidence: number;
  subtleConflicts?: SubtleConflict[];
}

interface Sa2Raw {
  principleAlignment: number;
  confidence: number;
  subtleDesignConflicts?: SubtleDesignConflict[];
}

/** Extract the first JSON object from a raw LLM reply. */
export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(candidate.trim());
  } catch (err) {
    throw new LayerLlmError(
      'malformed-json',
      `Failed to parse JSON: ${(err as Error).message}`,
      raw,
    );
  }
}

function requireNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || Number.isNaN(v)) {
    throw new LayerLlmError('missing-field', `Expected number at '${key}'`);
  }
  return v;
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function filterConflicts<T extends { confidence: number }>(
  list: T[] | undefined,
): { kept: T[]; suppressed: number } {
  if (!list) return { kept: [], suppressed: 0 };
  let suppressed = 0;
  const kept: T[] = [];
  for (const c of list) {
    if (typeof c.confidence !== 'number' || c.confidence < CONFIDENCE_THRESHOLD) {
      suppressed++;
    } else {
      kept.push({ ...c, confidence: clampConfidence(c.confidence) });
    }
  }
  return { kept, suppressed };
}

function parseSa1(raw: unknown): Sa1Raw {
  if (!raw || typeof raw !== 'object') {
    throw new LayerLlmError('malformed-json', 'SA-1 response is not a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  return {
    domainIntent: clamp01(requireNumber(obj, 'domainIntent')),
    confidence: clampConfidence(requireNumber(obj, 'confidence')),
    subtleConflicts: Array.isArray(obj.subtleConflicts)
      ? (obj.subtleConflicts as SubtleConflict[])
      : undefined,
  };
}

function parseSa2(raw: unknown): Sa2Raw {
  if (!raw || typeof raw !== 'object') {
    throw new LayerLlmError('malformed-json', 'SA-2 response is not a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  return {
    principleAlignment: clamp01(requireNumber(obj, 'principleAlignment')),
    confidence: clampConfidence(requireNumber(obj, 'confidence')),
    subtleDesignConflicts: Array.isArray(obj.subtleDesignConflicts)
      ? (obj.subtleDesignConflicts as SubtleDesignConflict[])
      : undefined,
  };
}

// ── Public API ──────────────────────────────────────────────────────

export interface Layer3Input {
  issueText: string;
  did: DesignIntentDocument;
  dsb?: DesignSystemBinding;
  preVerifiedSummary: string;
  llm: LLMClient;
}

export async function runLayer3(input: Layer3Input): Promise<LLMScoringResult> {
  const ctx: PromptContext = {
    issueText: input.issueText,
    did: input.did,
    dsb: input.dsb,
    preVerifiedSummary: input.preVerifiedSummary,
  };

  const sa1Prompt = buildSa1Prompt(ctx);
  const sa2Prompt = buildSa2Prompt(ctx);

  const [sa1Raw, sa2Raw] = await Promise.all([
    input.llm.complete(sa1Prompt),
    input.llm.complete(sa2Prompt),
  ]);

  const sa1 = parseSa1(extractJson(sa1Raw));
  const sa2 = parseSa2(extractJson(sa2Raw));

  const domainIntentDropped = sa1.confidence < CONFIDENCE_THRESHOLD;
  const principleAlignmentDropped = sa2.confidence < CONFIDENCE_THRESHOLD;

  const sa1Filter = filterConflicts(sa1.subtleConflicts);
  const sa2Filter = filterConflicts(sa2.subtleDesignConflicts);

  const suppressedFindings =
    (domainIntentDropped ? 1 : 0) +
    (principleAlignmentDropped ? 1 : 0) +
    sa1Filter.suppressed +
    sa2Filter.suppressed;

  return {
    domainIntent: domainIntentDropped ? 0 : sa1.domainIntent,
    domainIntentConfidence: sa1.confidence,
    subtleConflicts: sa1Filter.kept,
    principleAlignment: principleAlignmentDropped ? 0 : sa2.principleAlignment,
    principleAlignmentConfidence: sa2.confidence,
    subtleDesignConflicts: sa2Filter.kept,
    preVerifiedBoundaryApplied: true,
    suppressedFindings,
  };
}
