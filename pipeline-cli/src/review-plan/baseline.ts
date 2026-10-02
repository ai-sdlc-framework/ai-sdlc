/**
 * The baseline checklist: probes every review plan must contain, built by code
 * from the risk map. A planner may add probes and reorder; it cannot remove or
 * alter these.
 *
 * The security probe set follows the checks the security reviewer agent lists:
 * injection, authentication and authorization, secrets, path traversal,
 * server-side request forgery, and unsafe deserialization.
 *
 * Probes are deterministic: hunks and files are sorted, and ids derive from
 * those sorted positions, so the same risk map always yields the same baseline.
 *
 * @module review-plan/baseline
 */

import type {
  Baseline,
  Probe,
  ProbeFileRef,
  RiskHunk,
  RiskMapInput,
  SecurityCategory,
  TaskInput,
} from './types.js';

/** Bump when the checklist changes. Plans built against another version are rejected. */
export const BASELINE_CHECKLIST_VERSION = '1';

export const DEFAULT_TEST_COMMAND = 'pnpm test';

export function isHighRisk(hunk: RiskHunk, threshold: number): boolean {
  return !hunk.judged || hunk.riskScore >= threshold;
}

interface SecurityCheck {
  id: string;
  type: 'read' | 'trace';
  question: string;
}

const SECURITY_CHECKS: Record<SecurityCategory, readonly SecurityCheck[]> = {
  authentication: [
    {
      id: 'auth-checks',
      type: 'read',
      question: 'Is an authentication check missing or bypassable in this change?',
    },
    {
      id: 'auth-callers',
      type: 'trace',
      question: 'Do all callers of the changed code reach it only after authentication?',
    },
  ],
  authorization: [
    {
      id: 'privilege-escalation',
      type: 'read',
      question: 'Can this change let a caller act beyond its privileges?',
    },
    {
      id: 'authz-callers',
      type: 'trace',
      question: 'Do all callers of the changed code enforce authorization first?',
    },
  ],
  'input-handling': [
    {
      id: 'injection',
      type: 'read',
      question: 'Is untrusted input reaching a command, query, template, or markup sink unescaped?',
    },
    {
      id: 'ssrf',
      type: 'read',
      question: 'Can a caller control a URL that this code fetches?',
    },
    {
      id: 'deserialization',
      type: 'read',
      question: 'Is untrusted data passed to a parser, eval, or dynamic constructor?',
    },
  ],
  secrets: [
    {
      id: 'hardcoded-secrets',
      type: 'read',
      question: 'Does this change contain a hardcoded key, token, password, or credential?',
    },
  ],
  'shell-or-path': [
    {
      id: 'command-injection',
      type: 'read',
      question: 'Is any input interpolated into a shell command or process argument?',
    },
    {
      id: 'path-traversal',
      type: 'read',
      question: 'Is any input used in a file path without normalisation and containment?',
    },
  ],
  'manifest-or-workflow': [
    {
      id: 'workflow-injection',
      type: 'read',
      question: 'Does this manifest or workflow change run untrusted input or widen permissions?',
    },
    {
      id: 'manifest-secrets',
      type: 'read',
      question: 'Does this manifest or workflow change expose or hardcode a credential?',
    },
  ],
};

/** Exposed for tests and for documentation of the probe set. */
export function securityChecksFor(category: SecurityCategory): readonly SecurityCheck[] {
  return SECURITY_CHECKS[category];
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function range(h: RiskHunk): ProbeFileRef {
  return { path: h.file, startLine: h.startLine, endLine: h.endLine };
}

function safeId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
}

function underReferences(file: string, references: readonly string[]): boolean {
  return references.some((r) => {
    const ref = r.replace(/^\.\//, '');
    if (!ref) return false;
    return file === ref || file.startsWith(ref.endsWith('/') ? ref : `${ref}/`);
  });
}

/** Pick the test command from the allowlist: the first entry naming `test`. */
export function pickTestCommand(allowlist: readonly string[]): string | undefined {
  return allowlist.find((c) => /(^|[ :])test($|[ :])/.test(c));
}

export interface BuildBaselineOpts {
  riskThreshold: number;
  commandAllowlist: readonly string[];
}

export function buildBaselineProbes(
  riskMap: RiskMapInput,
  task: TaskInput,
  opts: BuildBaselineOpts,
): Baseline {
  const probes: Probe[] = [];
  const hunks = [...riskMap.hunks].sort(byId);

  // Per changed source file: its hunks in context and its changed tests.
  const sources = [...riskMap.changedSourceFiles].sort((a, b) => (a.path < b.path ? -1 : 1));
  sources.forEach((src, i) => {
    const own = hunks.filter((h) => h.file === src.path);
    const files: ProbeFileRef[] = [
      ...(own.length > 0 ? own.map(range) : [{ path: src.path }]),
      ...[...src.changedTests].sort().map((path) => ({ path })),
    ];
    probes.push({
      id: `file-read-${i}`,
      type: 'read',
      target: { files },
      question:
        src.changedTests.length > 0
          ? 'What does this change do, and do the changed tests exercise it?'
          : 'What does this change do? No test changed for this file; does it need one?',
      covers: own.map((h) => h.id),
      baseline: true,
    });
  });

  // Per high-risk hunk: read it and trace its callers.
  hunks.forEach((h, i) => {
    if (!isHighRisk(h, opts.riskThreshold)) return;
    probes.push({
      id: `hunk-read-${i}`,
      type: 'read',
      target: { files: [range(h)] },
      question: 'What does this high-risk hunk change, and what could go wrong?',
      covers: [h.id],
      baseline: true,
    });
    probes.push({
      id: `hunk-trace-${i}`,
      type: 'trace',
      target: { files: [range(h)], ...(h.symbols?.length ? { symbols: [...h.symbols] } : {}) },
      question: 'Who calls the changed code, and do the callers still hold their assumptions?',
      covers: [h.id],
      baseline: true,
    });
  });

  // Security probe set, regardless of ranking.
  hunks.forEach((h, i) => {
    const cats = [...new Set(h.flags)].sort();
    for (const cat of cats) {
      const checks = SECURITY_CHECKS[cat];
      if (!checks) continue;
      for (const check of checks) {
        probes.push({
          id: `sec-${check.id}-${i}`,
          type: check.type,
          target: { files: [range(h)] },
          question: check.question,
          covers: [h.id],
          baseline: true,
        });
      }
    }
  });

  // Tests: run the changed tests and compare criteria with test names and assertions.
  const testFiles = [...new Set(riskMap.changedTestFiles)].sort();
  const testCommand = pickTestCommand(opts.commandAllowlist);
  if (testFiles.length > 0 && testCommand) {
    probes.push({
      id: 'tests-run',
      type: 'run',
      target: { command: testCommand, files: testFiles.map((path) => ({ path })) },
      question: 'Do the changed tests pass?',
      covers: [],
      baseline: true,
    });
  }
  const criteria = [...riskMap.criteria].sort(byId);
  const idList = criteria.map((c) => safeId(c.id)).join(', ');
  probes.push({
    id: 'criteria-vs-tests',
    type: 'compare',
    target: {
      files: testFiles.map((path) => ({ path })),
      query: `Compare acceptance criteria (${idList}) with test names and assertions`.slice(0, 500),
    },
    question: 'Does each acceptance criterion have a test whose assertions would fail without it?',
    covers: [],
    baseline: true,
  });

  // One compare per criterion the coverage judgment marked likely uncovered.
  criteria.forEach((c, i) => {
    if (!c.likelyUncovered) return;
    probes.push({
      id: `criterion-uncovered-${i}`,
      type: 'compare',
      target: { query: `Acceptance criterion ${safeId(c.id)} against the change and its tests` },
      question: `Is this acceptance criterion met by the change and covered by a test? ${c.text.slice(0, 300)}`,
      covers: [],
      baseline: true,
    });
  });

  // Scope: files changed outside the task's declared references.
  const outside = [...new Set(riskMap.changedFiles)]
    .filter((f) => !underReferences(f, task.references))
    .sort();
  probes.push({
    id: 'scope-search',
    type: 'search',
    target: {
      query: 'Files changed outside the task references',
      ...(outside.length > 0 ? { files: outside.slice(0, 100).map((path) => ({ path })) } : {}),
    },
    question: 'Is each change outside the declared references justified by the task?',
    covers: [],
    baseline: true,
  });

  return { version: BASELINE_CHECKLIST_VERSION, probes };
}
