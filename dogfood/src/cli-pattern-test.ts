#!/usr/bin/env node
/**
 * pattern-test — Phase 2a deliverable (RFC-0008 §B.10.1, CR-3).
 *
 * Runs the Layer 1 deterministic SA scorer against a single issue text
 * (or a labeled issue set) and reports which patterns matched for a
 * specific DID field. Used by design authorities during DID authoring
 * to tune detection patterns before Phase 2b activation.
 *
 * Usage:
 *   pattern-test --did <name> --field <path> --issue-text "..."
 *   pattern-test --did <name> --field <path> --issue-file /path/to/body.txt
 *   pattern-test --did <name> --field <path> --stdin
 *   pattern-test --did <name> --field <path> --issue-set /path/to/fixtures.yaml
 *
 * Field paths:
 *   constraints.<id>
 *   scopeBoundaries.outOfScope.<label>
 *   antiPatterns.<id>                               (product-level)
 *   designPrinciples.<id>.antiPatterns.<id>
 *   brandIdentity.voiceAntiPatterns.<id>
 *   brandIdentity.visualIdentity.visualAntiPatterns.<id>
 *
 * Issue-set YAML shape:
 *   issues:
 *     - text: "..."
 *       shouldMatch: true
 *     - text: "..."
 *       shouldMatch: false
 *
 * Exit codes:
 *   0 — all tests passed (FP rate ≤ 20% when using --issue-set)
 *   1 — FP rate > 20% (CR-3 gate) OR usage error
 *   2 — depparse sidecar unreachable AND the selected field needs it
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { DesignIntentDocument } from '@ai-sdlc/reference';
import { DEFAULT_CONFIG_DIR_NAME, loadConfigAsync, resolveRepoRoot } from '@ai-sdlc/orchestrator';
import {
  compileDid,
  runLayer1,
  HttpDepparseClient,
  FakeDepparseClient,
  type CompiledDid,
  type DepparseClient,
  type DeterministicScoringResult,
} from '@ai-sdlc/orchestrator';

// ── Arg parsing ──────────────────────────────────────────────────────

interface ParsedArgs {
  didName?: string;
  field?: string;
  issueText?: string;
  issueFile?: string;
  useStdin: boolean;
  issueSet?: string;
  depparseUrl?: string;
  json: boolean;
}

function getArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.indexOf(flag) !== -1;
}

function parseArgs(argv: string[]): ParsedArgs {
  return {
    didName: getArg(argv, '--did'),
    field: getArg(argv, '--field'),
    issueText: getArg(argv, '--issue-text'),
    issueFile: getArg(argv, '--issue-file'),
    useStdin: hasFlag(argv, '--stdin'),
    issueSet: getArg(argv, '--issue-set'),
    depparseUrl: getArg(argv, '--depparse-url') ?? process.env.AI_SDLC_DEPPARSE_URL,
    json: hasFlag(argv, '--json'),
  };
}

// ── Field path resolution ────────────────────────────────────────────

export interface ResolvedField {
  kind: 'constraint' | 'outOfScope' | 'antiPattern';
  label: string;
  detectionPatterns: string[];
  /** True when the field requires the depparse sidecar (constraints only). */
  needsDepparse: boolean;
}

export function resolveField(
  did: DesignIntentDocument,
  path: string,
): ResolvedField | { error: string } {
  const parts = path.split('.');
  const root = parts[0];

  if (root === 'constraints') {
    const id = parts[1];
    const c = (did.spec.soulPurpose.constraints ?? []).find((x) => x.id === id);
    if (!c) return { error: `constraints.${id} not found` };
    return {
      kind: 'constraint',
      label: `${c.relationship} ${c.concept}`,
      detectionPatterns: c.detectionPatterns,
      needsDepparse: true,
    };
  }

  if (root === 'scopeBoundaries' && parts[1] === 'outOfScope') {
    const label = parts.slice(2).join('.');
    const entry = (did.spec.soulPurpose.scopeBoundaries?.outOfScope ?? []).find(
      (s) => s.label === label,
    );
    if (!entry) return { error: `scopeBoundaries.outOfScope.${label} not found` };
    return {
      kind: 'outOfScope',
      label: entry.label,
      detectionPatterns: [entry.label, ...(entry.synonyms ?? [])],
      needsDepparse: false,
    };
  }

  if (root === 'antiPatterns') {
    const id = parts[1];
    const a = (did.spec.soulPurpose.antiPatterns ?? []).find((x) => x.id === id);
    if (!a) return { error: `antiPatterns.${id} not found` };
    return {
      kind: 'antiPattern',
      label: a.label,
      detectionPatterns: a.detectionPatterns,
      needsDepparse: false,
    };
  }

  if (root === 'designPrinciples' && parts[2] === 'antiPatterns') {
    const principleId = parts[1];
    const apId = parts[3];
    const principle = did.spec.soulPurpose.designPrinciples.find((p) => p.id === principleId);
    if (!principle) return { error: `designPrinciples.${principleId} not found` };
    const a = (principle.antiPatterns ?? []).find((x) => x.id === apId);
    if (!a) return { error: `designPrinciples.${principleId}.antiPatterns.${apId} not found` };
    return {
      kind: 'antiPattern',
      label: `${principleId}:${a.label}`,
      detectionPatterns: a.detectionPatterns,
      needsDepparse: false,
    };
  }

  if (root === 'brandIdentity' && parts[1] === 'voiceAntiPatterns') {
    const id = parts[2];
    const a = (did.spec.brandIdentity?.voiceAntiPatterns ?? []).find((x) => x.id === id);
    if (!a) return { error: `brandIdentity.voiceAntiPatterns.${id} not found` };
    return {
      kind: 'antiPattern',
      label: `voice:${a.label}`,
      detectionPatterns: a.detectionPatterns,
      needsDepparse: false,
    };
  }

  if (
    root === 'brandIdentity' &&
    parts[1] === 'visualIdentity' &&
    parts[2] === 'visualAntiPatterns'
  ) {
    const id = parts[3];
    const a = (did.spec.brandIdentity?.visualIdentity?.visualAntiPatterns ?? []).find(
      (x) => x.id === id,
    );
    if (!a) return { error: `brandIdentity.visualIdentity.visualAntiPatterns.${id} not found` };
    return {
      kind: 'antiPattern',
      label: `visual:${a.label}`,
      detectionPatterns: a.detectionPatterns,
      needsDepparse: false,
    };
  }

  return { error: `unrecognized field path: ${path}` };
}

// ── Output rendering (§B.10.1 shape) ─────────────────────────────────

export interface PatternMatchResult {
  pattern: string;
  matched: boolean;
  construction?: string;
  matchedText?: string;
}

export function renderPatternReport(opts: {
  fieldPath: string;
  fieldLabel: string;
  issueText: string;
  matches: PatternMatchResult[];
  violation: boolean;
  depparseSkipped: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`Pattern test: ${opts.fieldPath}`);
  lines.push(`Field: ${opts.fieldLabel}`);
  lines.push(`Issue text: "${opts.issueText.replace(/\s+/g, ' ').trim()}"`);
  lines.push('');
  lines.push('Matched patterns:');
  for (const m of opts.matches) {
    const glyph = m.matched ? '✓' : '✗';
    const detail = m.matched
      ? m.construction
        ? ` (${m.construction}${m.matchedText ? ` — "${m.matchedText}"` : ''})`
        : ''
      : '';
    lines.push(`  ${glyph} ${m.pattern}${detail}`);
  }
  lines.push('');
  if (opts.depparseSkipped) {
    lines.push('Depparse sidecar unavailable — skipped dependency-based checks.');
    lines.push('');
  }
  lines.push(`Constraint violation: ${opts.violation ? 'YES' : 'NO'}`);
  return lines.join('\n');
}

// ── Issue-set evaluation ─────────────────────────────────────────────

interface IssueSetEntry {
  text: string;
  shouldMatch: boolean;
}

interface IssueSetFile {
  issues: IssueSetEntry[];
}

export interface IssueSetStats {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  falsePositiveRate: number;
}

export function computeFalsePositiveRate(
  outcomes: Array<{ expected: boolean; matched: boolean }>,
): IssueSetStats {
  const stats = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
  for (const o of outcomes) {
    if (o.expected && o.matched) stats.truePositive++;
    else if (!o.expected && o.matched) stats.falsePositive++;
    else if (!o.expected && !o.matched) stats.trueNegative++;
    else stats.falseNegative++;
  }
  const denom = stats.falsePositive + stats.trueNegative;
  return {
    ...stats,
    falsePositiveRate: denom === 0 ? 0 : stats.falsePositive / denom,
  };
}

export const FALSE_POSITIVE_THRESHOLD = 0.2;

// ── Execution against a single issue ─────────────────────────────────

export interface RunFieldAgainstTextInput {
  issueText: string;
  did: DesignIntentDocument;
  compiled: CompiledDid;
  field: ResolvedField;
  depparse: DepparseClient;
}

export async function runFieldAgainstText(input: RunFieldAgainstTextInput): Promise<{
  report: string;
  violation: boolean;
  matches: PatternMatchResult[];
  layer1: DeterministicScoringResult;
  depparseSkipped: boolean;
}> {
  const { issueText, compiled, field, depparse } = input;
  const layer1 = await runLayer1({ issueText, compiled, depparse });

  const matches: PatternMatchResult[] = [];
  let violation = false;

  if (field.kind === 'constraint') {
    for (const pattern of field.detectionPatterns) {
      const match = layer1.constraintViolations.violations.find((v) => v.pattern === pattern);
      matches.push({
        pattern,
        matched: Boolean(match),
        construction: match?.construction,
        matchedText: match?.matchedText,
      });
    }
    violation = layer1.constraintViolations.violations.length > 0;
  } else if (field.kind === 'outOfScope') {
    for (const pattern of field.detectionPatterns) {
      const match = layer1.scopeGate.outOfScopeHits.find(
        (h) => h.matchedText.toLowerCase() === pattern.toLowerCase(),
      );
      matches.push({
        pattern,
        matched: Boolean(match),
        matchedText: match?.matchedText,
      });
    }
    // pattern-test cares about "did this specific field's pattern fire?" —
    // any matched pattern within this outOfScope entry is a violation for
    // authoring purposes, regardless of identityClass (core vs evolving).
    violation = matches.some((m) => m.matched);
  } else {
    const allHits = [...layer1.antiPatternHits.hits, ...layer1.designAntiPatternHits.hits];
    for (const pattern of field.detectionPatterns) {
      const match = allHits.find((h) => h.pattern === pattern);
      matches.push({
        pattern,
        matched: Boolean(match),
        matchedText: match?.matchedText,
      });
    }
    violation = matches.some((m) => m.matched);
  }

  return {
    report: renderPatternReport({
      fieldPath: `${field.kind}:${field.label}`,
      fieldLabel: field.label,
      issueText,
      matches,
      violation,
      depparseSkipped: layer1.constraintViolations.depparseSkipped,
    }),
    violation,
    matches,
    layer1,
    depparseSkipped: layer1.constraintViolations.depparseSkipped,
  };
}

// ── Depparse client construction ─────────────────────────────────────

function makeDepparseClient(url: string | undefined, needsDepparse: boolean): DepparseClient {
  if (!needsDepparse || !url) return new FakeDepparseClient();
  return new HttpDepparseClient({ baseUrl: url, retries: 1 });
}

// ── Main ─────────────────────────────────────────────────────────────

async function loadDid(name: string): Promise<DesignIntentDocument | undefined> {
  const workDir = await resolveRepoRoot();
  const config = await loadConfigAsync(join(workDir, DEFAULT_CONFIG_DIR_NAME));
  return config.designIntentDocuments?.find((d) => d.metadata.name === name);
}

function readStdinSync(): string {
  return readFileSync(0, 'utf-8');
}

async function resolveIssueText(args: ParsedArgs): Promise<string | undefined> {
  if (args.issueText) return args.issueText;
  if (args.issueFile) {
    if (!existsSync(args.issueFile)) {
      console.error(`--issue-file not found: ${args.issueFile}`);
      process.exit(1);
    }
    return readFileSync(args.issueFile, 'utf-8');
  }
  if (args.useStdin) return readStdinSync();
  return undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (!args.didName || !args.field) {
    console.error(
      'Usage: pattern-test --did <name> --field <path> (--issue-text <text> | --issue-file <path> | --stdin | --issue-set <yaml>)',
    );
    process.exit(1);
  }

  const did = await loadDid(args.didName);
  if (!did) {
    console.error(`DID not found: ${args.didName}`);
    process.exit(1);
  }

  const field = resolveField(did, args.field);
  if ('error' in field) {
    console.error(field.error);
    process.exit(1);
  }

  const compiled = compileDid(did);
  const depparse = makeDepparseClient(args.depparseUrl, field.needsDepparse);

  if (args.issueSet) {
    await runIssueSet(args, did, compiled, field, depparse);
    return;
  }

  const issueText = await resolveIssueText(args);
  if (!issueText) {
    console.error(
      'No issue text provided — use --issue-text, --issue-file, --stdin, or --issue-set',
    );
    process.exit(1);
  }

  const result = await runFieldAgainstText({
    issueText,
    did,
    compiled,
    field,
    depparse,
  });
  console.log(result.report);
}

async function runIssueSet(
  args: ParsedArgs,
  did: DesignIntentDocument,
  compiled: CompiledDid,
  field: ResolvedField,
  depparse: DepparseClient,
): Promise<void> {
  if (!existsSync(args.issueSet!)) {
    console.error(`--issue-set not found: ${args.issueSet}`);
    process.exit(1);
  }

  const raw = readFileSync(args.issueSet!, 'utf-8');
  const doc = parseYaml(raw) as IssueSetFile;
  if (!doc?.issues || !Array.isArray(doc.issues)) {
    console.error(`Invalid issue-set YAML: missing "issues" array`);
    process.exit(1);
  }

  const outcomes: Array<{ expected: boolean; matched: boolean }> = [];
  let depparseSkippedAnywhere = false;
  for (const entry of doc.issues) {
    const result = await runFieldAgainstText({
      issueText: entry.text,
      did,
      compiled,
      field,
      depparse,
    });
    outcomes.push({ expected: entry.shouldMatch, matched: result.violation });
    if (result.depparseSkipped) depparseSkippedAnywhere = true;
  }

  const stats = computeFalsePositiveRate(outcomes);
  console.log(`Issue set: ${args.issueSet}`);
  console.log(`Evaluated ${outcomes.length} issues against ${field.label}`);
  console.log(`  TP: ${stats.truePositive}`);
  console.log(`  FP: ${stats.falsePositive}`);
  console.log(`  TN: ${stats.trueNegative}`);
  console.log(`  FN: ${stats.falseNegative}`);
  console.log(`  False-positive rate: ${(stats.falsePositiveRate * 100).toFixed(1)}%`);
  if (depparseSkippedAnywhere) {
    console.log('  (depparse sidecar unavailable for at least one evaluation)');
  }
  if (stats.falsePositiveRate > FALSE_POSITIVE_THRESHOLD) {
    console.log(
      `\nFAIL: false-positive rate ${(stats.falsePositiveRate * 100).toFixed(1)}% exceeds the ${(FALSE_POSITIVE_THRESHOLD * 100).toFixed(0)}% gate (CR-3). Refine patterns before Phase 2b activation.`,
    );
    process.exit(1);
  }
  console.log('\nPASS: patterns within the 20% false-positive gate');
}

// Only run `main()` when invoked directly, not when imported by tests.
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('cli-pattern-test.js') ||
    process.argv[1].endsWith('cli-pattern-test.ts'));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
