/** Setup asks once whether agents may merge; the review count follows (AISDLC-1384). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  agentMergeScaffoldDefaults,
  agentMergeSummaryLines,
  parseAgentMergeFlag,
  readGhLogin,
  resolveAgentMergeChoice,
} from './init-agent-merge.js';
import { scaffoldManifestEntries, buildWizardFlags } from './init.js';
import { applyBranchProtection, approvalSummary, type WizardFlags } from './init-features.js';
import {
  allowMergeFromAgentRole,
  readAllowMerge,
  requiredApprovingReviewCount,
  reviewControlSatisfied,
} from './branch-protection-shared.js';
import { checkAttestationGovernance, renderDoctorReport, type DoctorAdapters } from './doctor.js';
import { checkAttestationGovernanceCheck } from './doctor-checks.js';

type Run = { stdout: string; exitCode: number; stderr?: string };

function gh(login: string | null) {
  const calls: string[][] = [];
  return {
    calls,
    runCommand: (cmd: string, args: string[]): Run => {
      calls.push([cmd, ...args]);
      if (args[0] === 'api' && args[1] === 'user') {
        return login ? { stdout: `${login}\n`, exitCode: 0 } : { stdout: '', exitCode: 1 };
      }
      if (args[0] === 'repo') return { stdout: 'owner/repo main\n', exitCode: 0 };
      if (args[0] === 'api' && args[1] === '-X') return { stdout: '{}', exitCode: 0 };
      return { stdout: '', exitCode: 1 };
    },
  };
}

const remote = { detected: true, org: 'owner', repo: 'repo' } as never;

const flags: WizardFlags = {
  yes: true,
  withDor: false,
  withAttestation: false,
  withClassifier: false,
  withBranchProtection: true,
  withWorkflows: false,
  withSignalIngestion: false,
  dryRun: false,
  force: false,
};

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-merge-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function governance(): { allowMerge: string; mergeAuthors: string[]; operational: string[] } {
  const doc = parseYaml(readFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), 'utf-8')) as {
    spec: { governance: { allowMerge: string; mergeAuthors: string[]; operational: string[] } };
  };
  return doc.spec.governance;
}

async function initWith(answer: 'yes' | 'no' | undefined, login: string | null) {
  const stub = gh(login);
  const choice = resolveAgentMergeChoice(answer, stub);
  await scaffoldManifestEntries(dir, '.ai-sdlc', false, remote, 'coding', '', choice.merge);
  const logs: string[] = [];
  const bp = await applyBranchProtection(dir, flags, {
    runCommand: stub.runCommand,
    log: (l: string) => logs.push(l),
  });
  const body = JSON.parse(bp.bodyJson) as {
    required_pull_request_reviews: { required_approving_review_count: number };
  };
  return {
    choice,
    logs,
    count: body.required_pull_request_reviews.required_approving_review_count,
  };
}

describe('init --agent-merge (AISDLC-1384)', () => {
  it('AC1: yes with a readable gh login writes onGreenClean, the login, land-eligible-prs and a review count of 0', async () => {
    const { choice, logs, count } = await initWith('yes', 'octo');
    expect(governance()).toEqual({
      allowMerge: 'onGreenClean',
      mergeAuthors: ['octo'],
      operational: ['land-eligible-prs'],
    });
    expect(count).toBe(0);
    expect(choice.reason).toContain('agent merging on');
    expect(logs.join('\n')).toContain('the verdict gate ai-sdlc/pr-ready is the review control');
  });

  it('AC2: no writes never, empty lists and a review count of 1', async () => {
    const { count, choice } = await initWith('no', 'octo');
    expect(governance()).toEqual({ allowMerge: 'never', mergeAuthors: [], operational: [] });
    expect(count).toBe(1);
    expect(choice.reason).toContain('you answered no');
  });

  it('AC2: no flag writes never, empty lists and a review count of 1, without reading gh', async () => {
    const stub = gh('octo');
    const choice = resolveAgentMergeChoice(undefined, stub);
    expect(stub.calls).toEqual([]);
    expect(choice.reason).toContain('no answer');
    const { count } = await initWith(undefined, 'octo');
    expect(governance()).toEqual({ allowMerge: 'never', mergeAuthors: [], operational: [] });
    expect(count).toBe(1);
  });

  it('AC3: yes with no readable gh login writes never and says why', async () => {
    const { choice, count } = await initWith('yes', null);
    expect(governance()).toEqual({ allowMerge: 'never', mergeAuthors: [], operational: [] });
    expect(count).toBe(1);
    expect(choice.reason).toContain('gh login could not be read');
    const printed = (logSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n');
    expect(printed).toContain('allowMerge: never');
  });

  it('AC5: re-running on an existing merge block leaves it unchanged and prints the current values', async () => {
    await initWith('yes', 'octo');
    const before = readFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), 'utf-8');
    logSpy.mockClear();
    await scaffoldManifestEntries(dir, '.ai-sdlc', false, remote, 'coding', '');
    expect(readFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), 'utf-8')).toBe(before);
    const printed = (logSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n');
    expect(printed).toContain('left unchanged');
    expect(printed).toContain('allowMerge: onGreenClean');
    expect(printed).toContain('octo');
  });

  it('validates the flag value and carries it into the wizard flags', () => {
    expect(parseAgentMergeFlag(undefined)).toEqual({ ok: true });
    expect(parseAgentMergeFlag('YES')).toEqual({ ok: true, value: 'yes' });
    expect(parseAgentMergeFlag('maybe').ok).toBe(false);
    expect(buildWizardFlags({ agentMerge: 'yes' }).agentMerge).toBe('yes');
    expect(buildWizardFlags({}).agentMerge).toBeUndefined();
  });

  it('rejects a gh login that is not a login', () => {
    expect(
      readGhLogin({ runCommand: () => ({ stdout: 'not a login\n', exitCode: 0 }) }),
    ).toBeNull();
    expect(
      readGhLogin({
        runCommand: () => {
          throw new Error('spawn');
        },
      }),
    ).toBeNull();
  });

  it('renders scaffold answers and summary lines for both values', () => {
    expect(
      agentMergeScaffoldDefaults({
        allowMerge: 'onGreenClean',
        mergeAuthors: ['a', 'b'],
        operational: ['land-eligible-prs'],
      }),
    ).toEqual({
      allowMerge: 'onGreenClean',
      mergeAuthors: 'a,b',
      operational: 'land-eligible-prs',
    });
    expect(agentMergeSummaryLines('never', []).join('\n')).toContain(
      '1: a human approval is required; you cannot approve your own pull requests',
    );
    expect(agentMergeSummaryLines('onGreenClean', []).join('\n')).toContain('nobody');
    expect(approvalSummary('onGreenClean')).toContain('No approval is needed');
  });
});

describe('allowMerge resolution and the review count', () => {
  it('reads allowMerge from agent-role.yaml text', () => {
    const t = (g: string) => `spec:\n  governance:\n${g}`;
    expect(allowMergeFromAgentRole(null)).toBe('never');
    expect(allowMergeFromAgentRole(t('    allowMerge: onGreenClean\n'))).toBe('onGreenClean');
    expect(allowMergeFromAgentRole(t('    preset: operator-trusted\n'))).toBe('onGreenClean');
    expect(allowMergeFromAgentRole(t('    allowMerge: always\n'))).toBe('never');
    expect(allowMergeFromAgentRole('spec: [unclosed')).toBe('never');
    expect(readAllowMerge(join(dir, 'absent'))).toBe('never');
  });

  it('derives the count and the acceptable pairings', () => {
    expect(requiredApprovingReviewCount('onGreenClean')).toBe(0);
    expect(requiredApprovingReviewCount('never')).toBe(1);
    expect(reviewControlSatisfied(1, 'never', false)).toBe(true);
    expect(reviewControlSatisfied(0, 'onGreenClean', true)).toBe(true);
    expect(reviewControlSatisfied(0, 'onGreenClean', false)).toBe(false);
    expect(reviewControlSatisfied(0, 'never', true)).toBe(false);
  });
});

describe('doctor review-count pairing (AC4)', () => {
  function doctorAdapters(allowMerge: string, count: number, contexts: string[]): DoctorAdapters {
    mkdirSync(join(dir, '.ai-sdlc', 'attestations'), { recursive: true });
    writeFileSync(
      join(dir, '.ai-sdlc', 'agent-role.yaml'),
      `spec:\n  governance:\n    allowMerge: ${allowMerge}\n    mergeAuthors: [octo]\n    operational: [land-eligible-prs]\n`,
    );
    return {
      exists: (p) => p.endsWith('attestations'),
      readFile: (p) => {
        try {
          return readFileSync(p, 'utf-8');
        } catch {
          return null;
        }
      },
      runCommand: (_cmd, args) => {
        if (args[0] === 'repo') return { stdout: 'owner/repo main\n', exitCode: 0 };
        return {
          stdout: JSON.stringify({
            required_pull_request_reviews: { required_approving_review_count: count },
            required_status_checks: { contexts },
          }),
          exitCode: 0,
        };
      },
    };
  }

  function ctx(adapters: DoctorAdapters) {
    return { projectDir: dir, adapters } as unknown as Parameters<
      typeof checkAttestationGovernanceCheck
    >[0];
  }

  it('passes a count of 0 with onGreenClean and ai-sdlc/pr-ready required', () => {
    const a = doctorAdapters('onGreenClean', 0, ['ai-sdlc/pr-ready']);
    const gov = checkAttestationGovernance(dir, a);
    expect(gov.enforcementConfigured).toBe(true);
    expect(gov.reviewPairingError).toBeUndefined();
    const r = checkAttestationGovernanceCheck(ctx(a));
    expect(r.severity).toBe('pass');
    expect(r.title).toContain('0 approving reviews with allowMerge: onGreenClean');
  });

  it('fails a count of 0 with never and names the pairing', () => {
    const a = doctorAdapters('never', 0, ['ai-sdlc/pr-ready']);
    const gov = checkAttestationGovernance(dir, a);
    expect(gov.enforcementConfigured).toBe(false);
    const r = checkAttestationGovernanceCheck(ctx(a));
    expect(r.severity).toBe('fail');
    expect(r.title).toContain('allowMerge is never');
    expect(r.title).toContain('allowMerge: onGreenClean and ai-sdlc/pr-ready required');
    expect(renderDoctorReport(gov).join('\n')).toContain('ERROR branch protection requires 0');
  });

  it('fails a count of 0 with onGreenClean when ai-sdlc/pr-ready is not required', () => {
    const a = doctorAdapters('onGreenClean', 0, ['other']);
    const gov = checkAttestationGovernance(dir, a);
    expect(gov.reviewPairingError).toContain('ai-sdlc/pr-ready is not required');
  });

  it('still passes a count of 1 with never', () => {
    const a = doctorAdapters('never', 1, ['ai-sdlc/pr-ready']);
    const r = checkAttestationGovernanceCheck(ctx(a));
    expect(r.severity).toBe('pass');
    expect(r.title).toContain('+ approving review');
  });
});
