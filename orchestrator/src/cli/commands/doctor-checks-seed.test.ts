/**
 * Hermetic tests for the AISDLC-582 doctor checks 4, 5, 6, 8, 9, 10 and the
 * `Backlog Drift` branch-protection signal (check 7 extension).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkAgentRoleConfig,
  checkDorConfig,
  checkTrustedReviewers,
  checkHuskyPrePushGate,
  fixHuskyPrePushGate,
  checkFeatureFlags,
  checkFeatureWorkflows,
  checkAttestationGovernanceCheck,
  DOCTOR_CHECKS,
  type DoctorCheckAdapters,
  type DoctorRunContext,
} from './doctor-checks.js';
import { fetchBranchProtectionStatus } from './branch-protection-shared.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-doctor-seed-test-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeAdapters(overrides: Partial<DoctorCheckAdapters> = {}): DoctorCheckAdapters {
  return {
    exists: (p) => existsSync(p),
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    },
    writeFile: (p, content) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf-8');
    },
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    homeDir: () => join(tmpDir, '__home__'),
    env: {},
    runCommand: () => ({ stdout: '', exitCode: 1 }),
    ...overrides,
  };
}

function ctxOf(overrides: Partial<DoctorCheckAdapters> = {}): DoctorRunContext {
  return { projectDir: tmpDir, adapters: makeAdapters(overrides) };
}

function put(rel: string, content: string): void {
  const p = join(tmpDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf-8');
}

const VALID_AGENT_ROLE = `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: dev
spec:
  role: developer
  goal: ship tasks
  tools: [Read]
`;

const VALID_DOR = `apiVersion: ai-sdlc.io/v1alpha1
kind: DorConfig
metadata:
  name: dor
spec:
  evaluationMode: warn-only
`;

describe('registry', () => {
  it('registers checks 4, 5, 6, 8, 9, 10', () => {
    const ids = DOCTOR_CHECKS.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'agent-role-config',
        'dor-config',
        'trusted-reviewers',
        'husky-pre-push-gate',
        'feature-flags',
        'feature-workflows',
      ]),
    );
  });
});

describe('check 4: agent-role config', () => {
  it('warns when missing', () => {
    const r = checkAgentRoleConfig(ctxOf());
    expect(r.severity).toBe('warn');
    expect(r.remediation).toMatch(/ai-sdlc init/);
  });
  it('passes a valid file', () => {
    put('.ai-sdlc/agent-role.yaml', VALID_AGENT_ROLE);
    expect(checkAgentRoleConfig(ctxOf()).severity).toBe('pass');
  });
  it('fails a schema violation with a remediation', () => {
    put('.ai-sdlc/agent-role.yaml', VALID_AGENT_ROLE.replace('  goal: ship tasks\n', ''));
    const r = checkAgentRoleConfig(ctxOf());
    expect(r.severity).toBe('fail');
    expect(r.title).toMatch(/schema validation/);
    expect(r.remediation).toMatch(/agent-role.schema.json/);
  });
  it('fails unparseable YAML', () => {
    put('.ai-sdlc/agent-role.yaml', 'a: [unclosed\n');
    const r = checkAgentRoleConfig(ctxOf());
    expect(r.severity).toBe('fail');
    expect(r.title).toMatch(/not parseable/);
  });
});

describe('check 5: dor config', () => {
  it('passes (skipped) when DoR is not enabled', () => {
    expect(checkDorConfig(ctxOf()).severity).toBe('pass');
  });
  it('warns when the workflow exists but the config is missing', () => {
    put('.github/workflows/dor-ingress.yml', 'name: x\n');
    expect(checkDorConfig(ctxOf()).severity).toBe('warn');
  });
  it('passes a valid config', () => {
    put('.ai-sdlc/dor-config.yaml', VALID_DOR);
    expect(checkDorConfig(ctxOf()).severity).toBe('pass');
  });
  it('fails an invalid evaluationMode', () => {
    put('.ai-sdlc/dor-config.yaml', VALID_DOR.replace('warn-only', 'bogus'));
    const r = checkDorConfig(ctxOf());
    expect(r.severity).toBe('fail');
    expect(r.remediation).toMatch(/dor-config.v1.schema.json/);
  });
});

describe('check 6: trusted reviewers + signing key', () => {
  const pair = generateKeyPairSync('ed25519');
  const pubPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const indent = (pem: string) =>
    pem
      .trim()
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n');
  const reviewersYaml = (pem: string) =>
    `reviewers:\n  - identity: 'a@b.com'\n    machine: 'm'\n    pubkey: |\n${indent(pem)}\n`;

  it('passes when attestation is not enabled and the file is absent', () => {
    expect(checkTrustedReviewers(ctxOf())[0].severity).toBe('pass');
  });
  it('fails when the verify workflow exists but the keyring is missing', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    const r = checkTrustedReviewers(ctxOf());
    expect(r[0].severity).toBe('fail');
    expect(r[0].remediation).toMatch(/init --add attestation/);
  });
  it('fails an unparseable file', () => {
    put('.ai-sdlc/trusted-reviewers.yaml', 'reviewers: [unclosed\n');
    expect(checkTrustedReviewers(ctxOf())[0].severity).toBe('fail');
  });
  it('fails a schema violation (entry without pubkey)', () => {
    put('.ai-sdlc/trusted-reviewers.yaml', "reviewers:\n  - identity: 'a'\n");
    const r = checkTrustedReviewers(ctxOf());
    expect(r[0].severity).toBe('fail');
    expect(r[0].remediation).toMatch(/trusted-reviewers.schema.json/);
  });
  it('warns (not fails) on an empty keyring in a fresh repo with no attestations', () => {
    put('.ai-sdlc/trusted-reviewers.yaml', 'reviewers: []\n');
    const r = checkTrustedReviewers(ctxOf());
    expect(r[0].severity).toBe('warn');
    expect(r[0].title).toMatch(/no public keys/);
  });
  it('fails an empty keyring once attestations exist', () => {
    put('.ai-sdlc/trusted-reviewers.yaml', 'reviewers: []\n');
    put('.ai-sdlc/attestations/abc.v6.dsse.json', '{}');
    const r = checkTrustedReviewers(ctxOf());
    expect(r[0].severity).toBe('fail');
    expect(r[0].title).toMatch(/no public keys/);
  });
  it('warns when the operator signing key is absent', () => {
    put('.ai-sdlc/trusted-reviewers.yaml', reviewersYaml(pubPem));
    const r = checkTrustedReviewers(ctxOf());
    expect(r[0].severity).toBe('pass');
    expect(r[1]).toMatchObject({ id: 'operator-signing-key', severity: 'warn' });
  });
  it('fails an unreadable signing key', () => {
    put('.ai-sdlc/trusted-reviewers.yaml', reviewersYaml(pubPem));
    put('__home__/.ai-sdlc/signing-key.pem', 'not a key');
    expect(checkTrustedReviewers(ctxOf())[1].severity).toBe('fail');
  });
  it('passes when the signing key pubkey is listed', () => {
    put('.ai-sdlc/trusted-reviewers.yaml', reviewersYaml(pubPem));
    put('__home__/.ai-sdlc/signing-key.pem', privPem);
    expect(checkTrustedReviewers(ctxOf())[1].severity).toBe('pass');
  });
  it('warns when the signing key is not listed', () => {
    const other = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    put('.ai-sdlc/trusted-reviewers.yaml', reviewersYaml(other));
    put('__home__/.ai-sdlc/signing-key.pem', privPem);
    const r = checkTrustedReviewers(ctxOf());
    expect(r[1].severity).toBe('warn');
    expect(r[1].remediation).toMatch(/init-signing-key/);
  });
  it('accepts the repo trusted-reviewers.yaml shape (allowlist + ciOnly)', () => {
    put(
      '.ai-sdlc/trusted-reviewers.yaml',
      `${reviewersYaml(pubPem)}allowlist:\n  authors:\n    - login: dev\n`,
    );
    expect(checkTrustedReviewers(ctxOf())[0].severity).toBe('pass');
  });
});

describe('check 8: husky pre-push gate', () => {
  it('passes when attestation is not enabled', () => {
    expect(checkHuskyPrePushGate(ctxOf()).severity).toBe('pass');
  });
  it('fails when attestation is enabled and no hook exists', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    expect(checkHuskyPrePushGate(ctxOf()).severity).toBe('fail');
  });
  it('fails when the hook lacks the sign snippet', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    put('.husky/pre-push', 'npm test\n');
    expect(checkHuskyPrePushGate(ctxOf()).severity).toBe('fail');
  });
  it('passes when the hook references the sign snippet', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    put('.husky/pre-push', '# ai-sdlc:attestation-sign-block\n');
    expect(checkHuskyPrePushGate(ctxOf()).severity).toBe('pass');
  });
  it('passes for a non-husky .git/hooks/pre-push', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    put('.git/hooks/pre-push', 'bash check-attestation-sign.sh\n');
    expect(checkHuskyPrePushGate(ctxOf()).severity).toBe('pass');
  });
  it('fix appends the snippet to an existing hook, idempotently', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    put('.husky/pre-push', 'npm test');
    const first = fixHuskyPrePushGate(ctxOf());
    expect(first.applied).toBe(true);
    const text = readFileSync(join(tmpDir, '.husky/pre-push'), 'utf-8');
    expect(text.startsWith('npm test\n')).toBe(true);
    expect(text).toContain('ai-sdlc:attestation-sign-block');
    expect(checkHuskyPrePushGate(ctxOf()).severity).toBe('pass');
    expect(fixHuskyPrePushGate(ctxOf()).applied).toBe(false);
    expect(readFileSync(join(tmpDir, '.husky/pre-push'), 'utf-8')).toBe(text);
  });
  it('fix creates the hook when .husky/ exists but the hook does not', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    mkdirSync(join(tmpDir, '.husky'));
    expect(fixHuskyPrePushGate(ctxOf()).applied).toBe(true);
    expect(existsSync(join(tmpDir, '.husky/pre-push'))).toBe(true);
  });
  it('fix does nothing without a .husky directory', () => {
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    const r = fixHuskyPrePushGate(ctxOf());
    expect(r.applied).toBe(false);
    expect(existsSync(join(tmpDir, '.husky'))).toBe(false);
  });
});

describe('check 9: feature flags', () => {
  it('passes with defaults', () => {
    expect(checkFeatureFlags(ctxOf()).severity).toBe('pass');
  });
  it('passes with truthy / legacy values', () => {
    const env = { AI_SDLC_DEPS_COMPOSITION: 'on', AI_SDLC_AUTONOMOUS_ORCHESTRATOR: 'experimental' };
    expect(checkFeatureFlags(ctxOf({ env })).severity).toBe('pass');
  });
  it('warns on an opt-out value, naming the flag', () => {
    const r = checkFeatureFlags(ctxOf({ env: { AI_SDLC_DEPS_COMPOSITION: 'OFF' } }));
    expect(r.severity).toBe('warn');
    expect(r.title).toContain('AI_SDLC_DEPS_COMPOSITION');
    expect(r.remediation).toMatch(/Unset/);
  });
});

describe('check 10: feature workflows', () => {
  it('passes with nothing enabled', () => {
    expect(checkFeatureWorkflows(ctxOf()).severity).toBe('pass');
  });
  it('warns for each enabled feature missing its workflow', () => {
    put('.ai-sdlc/trusted-reviewers.yaml', 'reviewers: []\n');
    put('.ai-sdlc/dor-config.yaml', VALID_DOR);
    const r = checkFeatureWorkflows(ctxOf());
    expect(r.severity).toBe('warn');
    expect(r.title).toContain('verify-attestation.yml');
    expect(r.title).toContain('dor-ingress.yml');
    expect(r.remediation).toMatch(/init --add workflows/);
  });
  it('passes when the workflow files exist', () => {
    put('.ai-sdlc/trusted-reviewers.yaml', 'reviewers: []\n');
    put('.github/workflows/verify-attestation.yml', 'name: v\n');
    expect(checkFeatureWorkflows(ctxOf()).severity).toBe('pass');
  });
});

describe('Backlog Drift required context (check 7 extension)', () => {
  const protection = (contexts: string[]) => ({
    runCommand: (cmd: string, args: string[]) => {
      if (cmd === 'gh' && args[0] === 'repo') return { stdout: 'acme/w', exitCode: 0 };
      return {
        stdout: JSON.stringify({
          required_pull_request_reviews: { required_approving_review_count: 1 },
          required_status_checks: { contexts },
        }),
        exitCode: 0,
      };
    },
  });

  it('fetchBranchProtectionStatus reports requiresBacklogDrift', () => {
    expect(
      fetchBranchProtectionStatus(protection(['ai-sdlc/pr-ready', 'Backlog Drift']))
        .requiresBacklogDrift,
    ).toBe(true);
  });

  function governanceCtx(contexts: string[]): DoctorRunContext {
    put('.ai-sdlc/trusted-reviewers.yaml', 'reviewers: []\n');
    return ctxOf(protection(contexts));
  }

  it('warns when a backlog repo lacks the Backlog Drift context', () => {
    mkdirSync(join(tmpDir, 'backlog'));
    const r = checkAttestationGovernanceCheck(governanceCtx(['ai-sdlc/pr-ready']));
    expect(r.severity).toBe('warn');
    expect(r.title).toMatch(/Backlog Drift/);
  });
  it('passes when both contexts are required', () => {
    mkdirSync(join(tmpDir, 'backlog'));
    expect(
      checkAttestationGovernanceCheck(governanceCtx(['ai-sdlc/pr-ready', 'Backlog Drift']))
        .severity,
    ).toBe('pass');
  });
  it('does not nag a repo without a backlog directory', () => {
    expect(checkAttestationGovernanceCheck(governanceCtx(['ai-sdlc/pr-ready'])).severity).toBe(
      'pass',
    );
  });
});
