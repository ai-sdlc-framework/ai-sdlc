/**
 * AISDLC-1353: the scaffolded gate checks the review verdict, the retired
 * verifier is gone, and doctor / init replace only byte-identical old copies.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import {
  AI_SDLC_GATE_WORKFLOW,
  AI_SDLC_REVIEW_WORKFLOW,
  ATTESTATION_TEMPLATES,
  BASELINE_WORKFLOW_TEMPLATES,
  WORKFLOWS_TEMPLATES,
} from './init-templates.js';
import * as templates from './init-templates.js';
import {
  LEGACY_AI_SDLC_GATE_WORKFLOW,
  LEGACY_VERIFY_ATTESTATION_WORKFLOW,
} from './init-legacy-workflows.js';
import {
  checkLegacyWorkflows,
  fixLegacyWorkflows,
  type DoctorCheckAdapters,
  type DoctorRunContext,
} from './doctor-checks.js';
import { applyFeatureSelection, NO_FEATURES, type FeatureAdapters } from './init-features.js';
import type { WizardFlags } from './init-features.js';

const VERIFIER = '.github/workflows/verify-attestation.yml';
const GATE = '.github/workflows/ai-sdlc-gate.yml';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ai-sdlc-legacy-wf-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
  const p = join(tmpDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf-8');
}
function read(rel: string): string {
  return readFileSync(join(tmpDir, rel), 'utf-8');
}

function ctx(withRemove = true): DoctorRunContext {
  const adapters: Partial<DoctorCheckAdapters> = {
    exists: (p: string) => existsSync(p),
    readFile: (p: string) => (existsSync(p) ? readFileSync(p, 'utf-8') : null),
    writeFile: (p: string, c: string) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c, 'utf-8');
    },
    listDir: (p: string) => (existsSync(p) ? readdirSync(p) : []),
    homeDir: () => join(tmpDir, '__home__'),
    env: {},
    runCommand: () => ({ stdout: '', exitCode: 1 }),
    ...(withRemove ? { removeFile: (p: string) => unlinkSync(p) } : {}),
  };
  return { projectDir: tmpDir, adapters: adapters as DoctorCheckAdapters };
}

function featureAdapters(log: string[]): FeatureAdapters {
  const a: Partial<FeatureAdapters> = {
    writeFile: (p, c) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c, 'utf-8');
    },
    appendOnce: () => 'skipped',
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
    exists: (p) => existsSync(p),
    removeFile: (p) => unlinkSync(p),
    readTextFile: (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : null),
    chmodExecutable: () => undefined,
    realpath: (p) => p,
    isSymlink: () => false,
    runCommand: () => ({ stdout: '', exitCode: 0 }),
    log: (l) => {
      log.push(l);
    },
  };
  return a as FeatureAdapters;
}

const flags = { dryRun: false, force: false } as unknown as WizardFlags;

describe('scaffolded gate (AC 1)', () => {
  it('has a verdict-check job that pr-ready needs and calls the published CLI outside the checkout', () => {
    const doc = parseYaml(AI_SDLC_GATE_WORKFLOW) as {
      jobs: Record<string, { needs?: string | string[]; env?: Record<string, string> }>;
    };
    expect(Object.keys(doc.jobs)).toContain('verdict-check');
    expect(doc.jobs['pr-ready'].needs).toContain('verdict-check');
    expect(AI_SDLC_GATE_WORKFLOW).toMatch(
      /cli-attestation\.mjs" verdict-check[\s\S]*--post-status/,
    );
    expect(AI_SDLC_GATE_WORKFLOW).toContain('$RUNNER_TEMP/ai-sdlc-cli');
    expect(AI_SDLC_GATE_WORKFLOW).toContain('npm install');
    const version = doc.jobs['verdict-check'].env?.AI_SDLC_CLI_VERSION ?? '';
    const [maj, min] = version.split('.').map(Number);
    expect(maj > 0 || min >= 41).toBe(true);
  });

  it('tolerates a skipped verdict-check in the pr-ready rollup', () => {
    const doc = parseYaml(AI_SDLC_GATE_WORKFLOW) as {
      jobs: Record<string, { steps?: { with?: Record<string, string> }[] }>;
    };
    const skips = doc.jobs['pr-ready'].steps
      ?.map((st) => st.with?.['allowed-skips'])
      .find((v) => v !== undefined);
    expect(skips?.split(',').map((x) => x.trim())).toContain('verdict-check');
  });
});

describe('scaffold sets (AC 2, 4)', () => {
  it('no set writes verify-attestation.yml and the approval flag is gone', () => {
    for (const set of [ATTESTATION_TEMPLATES, WORKFLOWS_TEMPLATES, BASELINE_WORKFLOW_TEMPLATES]) {
      expect(Object.keys(set.files)).not.toContain(VERIFIER);
    }
    expect('ADOPTER_TEMPLATE_POSTS_APPROVAL' in templates).toBe(false);
    expect('VERIFY_ATTESTATION_WORKFLOW' in templates).toBe(false);
  });
  it('keeps the review stub in the workflows list', () => {
    expect(WORKFLOWS_TEMPLATES.files['.github/workflows/ai-sdlc-review.yml']).toBe(
      AI_SDLC_REVIEW_WORKFLOW,
    );
  });
});

describe('doctor legacy-workflows check (AC 5)', () => {
  it('fails on an edited verifier that calls the retired verify', () => {
    put(VERIFIER, `${LEGACY_VERIFY_ATTESTATION_WORKFLOW}# edited\n`);
    const r = checkLegacyWorkflows(ctx());
    expect(r.severity).toBe('fail');
    expect(r.title).toContain('cli-attestation verify');
    expect(r.title).toMatch(/line \d+/);
  });
  it('fails on a gate with no verdict-check job', () => {
    put(GATE, LEGACY_AI_SDLC_GATE_WORKFLOW);
    const r = checkLegacyWorkflows(ctx());
    expect(r.severity).toBe('fail');
    expect(r.title).toContain('no verdict-check job');
  });
  it('names the edit for an edited gate, including the needs line', () => {
    put(GATE, `${LEGACY_AI_SDLC_GATE_WORKFLOW}# mine\n`);
    const r = checkLegacyWorkflows(ctx());
    expect(r.title).toContain('add `verdict-check` to the pr-ready');
    expect(r.title).toContain('needs: [detect, lint, build-test, coverage]');
  });
  it('passes on the new scaffold and on an empty repo', () => {
    expect(checkLegacyWorkflows(ctx()).severity).toBe('pass');
    put(GATE, AI_SDLC_GATE_WORKFLOW);
    expect(checkLegacyWorkflows(ctx()).severity).toBe('pass');
  });
  it('does not flag an unrelated verifier file', () => {
    put(VERIFIER, 'name: mine\n');
    expect(checkLegacyWorkflows(ctx()).severity).toBe('pass');
  });
});

describe('doctor --fix (AC 6)', () => {
  it('deletes a byte-identical verifier and rewrites a byte-identical gate', () => {
    put(VERIFIER, LEGACY_VERIFY_ATTESTATION_WORKFLOW);
    put(GATE, LEGACY_AI_SDLC_GATE_WORKFLOW);
    const r = fixLegacyWorkflows(ctx());
    expect(r.applied).toBe(true);
    expect(existsSync(join(tmpDir, VERIFIER))).toBe(false);
    expect(read(GATE)).toBe(AI_SDLC_GATE_WORKFLOW);
    expect(checkLegacyWorkflows(ctx()).severity).toBe('pass');
  });
  it('leaves edited copies unchanged and reports the file', () => {
    const edited = `${LEGACY_VERIFY_ATTESTATION_WORKFLOW}# edited\n`;
    const editedGate = `${LEGACY_AI_SDLC_GATE_WORKFLOW}# edited\n`;
    put(VERIFIER, edited);
    put(GATE, editedGate);
    const r = fixLegacyWorkflows(ctx());
    expect(r.applied).toBe(false);
    expect(r.detail).toContain(VERIFIER);
    expect(r.detail).toContain(GATE);
    expect(read(VERIFIER)).toBe(edited);
    expect(read(GATE)).toBe(editedGate);
  });
  it('does nothing on a clean repo and cannot delete without a removeFile adapter', () => {
    expect(fixLegacyWorkflows(ctx()).applied).toBe(false);
    put(VERIFIER, LEGACY_VERIFY_ATTESTATION_WORKFLOW);
    const r = fixLegacyWorkflows(ctx(false));
    expect(r.applied).toBe(false);
    expect(existsSync(join(tmpDir, VERIFIER))).toBe(true);
  });
});

describe('init re-run (AC 6)', () => {
  it('replaces byte-identical old files', async () => {
    put(VERIFIER, LEGACY_VERIFY_ATTESTATION_WORKFLOW);
    put(GATE, LEGACY_AI_SDLC_GATE_WORKFLOW);
    const log: string[] = [];
    await applyFeatureSelection(
      tmpDir,
      { ...NO_FEATURES, workflows: true },
      flags,
      featureAdapters(log),
    );
    expect(existsSync(join(tmpDir, VERIFIER))).toBe(false);
    expect(read(GATE)).toBe(AI_SDLC_GATE_WORKFLOW);
    expect(log.join('\n')).toContain(`deleted ${VERIFIER}`);
  });
  it('leaves edited copies unchanged and prints the file and the change', async () => {
    const edited = `${LEGACY_VERIFY_ATTESTATION_WORKFLOW}# edited\n`;
    put(VERIFIER, edited);
    const log: string[] = [];
    await applyFeatureSelection(
      tmpDir,
      { ...NO_FEATURES, workflows: true },
      flags,
      featureAdapters(log),
    );
    expect(read(VERIFIER)).toBe(edited);
    const out = log.join('\n');
    expect(out).toContain(`WARNING ${VERIFIER} left unchanged`);
    expect(out).toContain('Delete the file');
  });
  it('dry run changes nothing', async () => {
    put(VERIFIER, LEGACY_VERIFY_ATTESTATION_WORKFLOW);
    const log: string[] = [];
    await applyFeatureSelection(
      tmpDir,
      { ...NO_FEATURES, workflows: true },
      { dryRun: true, force: false } as unknown as WizardFlags,
      featureAdapters(log),
    );
    expect(existsSync(join(tmpDir, VERIFIER))).toBe(true);
    expect(log.join('\n')).toContain(`would delete ${VERIFIER}`);
  });
});
