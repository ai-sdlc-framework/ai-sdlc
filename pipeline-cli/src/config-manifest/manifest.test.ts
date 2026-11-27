import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_VERSION_PATH,
  REQUIRED_CONFIG_MANIFEST,
  compareVersions,
  configPreflight,
  configVersionNotice,
  formatMissingConfig,
  missingConfigEntries,
  newestConfigVersion,
  readConfigVersion,
  AGENT_MERGE_YES_OPERATIONAL,
  AGENT_ROLE_MERGE_DEFAULTS,
  agentRoleMergeFromAnswers,
  renderAgentRole,
  renderAgentRoleGovernance,
  scaffoldConfig,
  type ConfigEntry,
} from './manifest.js';
import { CODE_TEST_MERGED_REVIEWER_SET, classifyReviewerSet } from '../steps/reviewer-set.js';
import { checkReviewerKindCoverage } from '../../attestation-core/review-scope-core.mjs';
import { parseOperationalPolicy } from '../hierarchy/operational.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import { loadKnowledgeConfig, loadRetrievalConfig } from '../knowledge/config.js';
import { validateKnowledge } from '../knowledge/store.js';

const answers = { org: 'acme', repo: 'widgets' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfg-manifest-'));
});
afterEach(() => removeFixtureDir(dir));

describe('manifest contents (AC1)', () => {
  it('lists every .ai-sdlc path read for attestation and review, each with a since version', () => {
    const paths = REQUIRED_CONFIG_MANIFEST.map((e) => e.path);
    for (const p of [
      '.ai-sdlc/review-policy.md',
      '.ai-sdlc/agent-role.yaml',
      '.ai-sdlc/pipeline.yaml',
    ]) {
      expect(paths).toContain(p);
    }
    for (const e of REQUIRED_CONFIG_MANIFEST) expect(e.since).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('lists the optional workflow document, rendered from the validated default', async () => {
    const e = REQUIRED_CONFIG_MANIFEST.find((x) => x.path === '.ai-sdlc/workflow.yaml');
    expect(e?.optional).toBe(true);
    expect(e?.since).toBe('0.36.0');
    const { validateWorkflowYaml } = await import('../workflow/validate.js');
    expect(validateWorkflowYaml(e!.render({})).ok).toBe(true);
    expect(missingConfigEntries(dir).map((m) => m.id)).not.toContain('workflow');
  });
});

describe('preflight (AC3)', () => {
  it('refuses on a missing keyring and review policy with the init command', () => {
    mkdirSync(join(dir, '.ai-sdlc'));
    writeFileSync(join(dir, '.ai-sdlc/agent-role.yaml'), 'x');
    writeFileSync(join(dir, '.ai-sdlc/pipeline.yaml'), 'x');
    const r = configPreflight(dir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('.ai-sdlc/review-policy.md');
    expect(r.reason).toContain('/ai-sdlc init');
    expect(r.reason).toBe(formatMissingConfig(r.missing));
  });

  it('passes once everything exists', async () => {
    await scaffoldConfig({ projectDir: dir, defaults: answers });
    expect(configPreflight(dir)).toEqual({ ok: true });
    expect(formatMissingConfig([])).toBe('');
  });
});

describe('scaffold (AC2)', () => {
  it('non-interactive with defaults creates every entry and writes configVersion', async () => {
    const res = await scaffoldConfig({ projectDir: dir, defaults: answers });
    expect(res.failed).toEqual([]);
    expect(res.created).toHaveLength(REQUIRED_CONFIG_MANIFEST.length);
    expect(readConfigVersion(dir)).toBe(newestConfigVersion());
  });

  it('non-interactive without defaults fails naming the missing entries and writes no version', async () => {
    const res = await scaffoldConfig({ projectDir: dir });
    expect(res.failed.map((f) => f.path)).toEqual(['.ai-sdlc/pipeline.yaml']);
    expect(res.failed[0].reason).toContain('missing answer');
    expect(existsSync(join(dir, CONFIG_VERSION_PATH))).toBe(false);
  });

  it('re-run is a no-op without force and rewrites with force', async () => {
    await scaffoldConfig({ projectDir: dir, defaults: answers });
    const again = await scaffoldConfig({ projectDir: dir, defaults: answers });
    expect(again.created).toEqual([]);
    expect(again.skipped).toHaveLength(REQUIRED_CONFIG_MANIFEST.length);
    const forced = await scaffoldConfig({ projectDir: dir, defaults: answers, force: true });
    expect(forced.created).toHaveLength(REQUIRED_CONFIG_MANIFEST.length);
  });

  it('skipOperatorInput scaffolds only default-able entries (doctor --fix)', async () => {
    const res = await scaffoldConfig({ projectDir: dir, skipOperatorInput: true });
    expect(res.created).toEqual([
      '.ai-sdlc/review-policy.md',
      '.ai-sdlc/agent-role.yaml',
      '.ai-sdlc/workflow.yaml',
      '.ai-sdlc/context.yaml',
      '.ai-sdlc/knowledge/README.md',
    ]);
  });

  it('doctor --fix does not stamp configVersion while operator-input entries are missing', async () => {
    await scaffoldConfig({ projectDir: dir, skipOperatorInput: true });
    expect(readConfigVersion(dir)).toBeNull();
  });

  it('after bumping an entry since, a re-run prompts only for that entry', async () => {
    await scaffoldConfig({ projectDir: dir, defaults: answers });
    const added: ConfigEntry = {
      id: 'new-thing',
      path: '.ai-sdlc/new-thing.yaml',
      since: '9.9.0',
      description: 'a new required file',
      operatorInput: true,
      prompts: [{ key: 'color', question: 'Color?' }],
      render: (a) => `color: ${a.color}\n`,
    };
    const manifest = [...REQUIRED_CONFIG_MANIFEST, added];
    expect(configVersionNotice(dir, manifest)).toContain('9.9.0');
    const asked: string[] = [];
    const res = await scaffoldConfig({
      projectDir: dir,
      manifest,
      prompt: async (q) => {
        asked.push(q);
        return 'blue';
      },
    });
    expect(asked).toEqual(['Color?']);
    expect(res.created).toEqual(['.ai-sdlc/new-thing.yaml']);
    expect(readConfigVersion(dir)).toBe('9.9.0');
    expect(configVersionNotice(dir, manifest)).toBeNull();
  });
});

describe('versions and notice (AC6)', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
  });

  it('prints for an older or unversioned config, silent otherwise', () => {
    expect(configVersionNotice(dir)).toBeNull(); // no .ai-sdlc dir
    mkdirSync(join(dir, '.ai-sdlc'));
    expect(configVersionNotice(dir)).toContain('unversioned');
    writeFileSync(join(dir, CONFIG_VERSION_PATH), "configVersion: '0.1.0'\n");
    expect(configVersionNotice(dir)).toContain('0.1.0');
    writeFileSync(join(dir, CONFIG_VERSION_PATH), `configVersion: '${newestConfigVersion()}'\n`);
    expect(configVersionNotice(dir)).toBeNull();
    expect(missingConfigEntries(dir)).toHaveLength(
      REQUIRED_CONFIG_MANIFEST.filter((e) => e.optional !== true).length,
    );
  });
});

describe('verifier and classifier agree on the reviewer set (AC5)', () => {
  it('classifier picks the two-reviewer set and the verifier accepts exactly those two', () => {
    const c = classifyReviewerSet({ changedPaths: ['src/feature.ts', 'src/feature.test.ts'] });
    expect(c.set).toBe('two');
    expect(c.reviewers).toEqual([...CODE_TEST_MERGED_REVIEWER_SET]);
    expect(checkReviewerKindCoverage(c.reviewers, 'two')).toEqual({ ok: true, missing: [] });
  });

  it('the two-reviewer envelope is rejected when the diff needs three', () => {
    const c = classifyReviewerSet({ changedPaths: ['scripts/verify-attestation.mjs'] });
    expect(c.set).toBe('three');
    expect(checkReviewerKindCoverage(CODE_TEST_MERGED_REVIEWER_SET, 'three').ok).toBe(false);
    expect(checkReviewerKindCoverage(c.reviewers, 'three').ok).toBe(true);
  });
});

describe('cli-init pipeline template (AISDLC-1281)', () => {
  it('has no deprecated stages block and validates against the Pipeline schema', async () => {
    const entry = REQUIRED_CONFIG_MANIFEST.find((e) => e.path === '.ai-sdlc/pipeline.yaml')!;
    const text = entry.render({ org: 'acme', repo: 'widgets' });
    expect(text).not.toMatch(/^\s*stages:/m);
    const { load: parse } = await import('js-yaml');
    const { validate } = await import('@ai-sdlc/reference');
    expect(validate('Pipeline', parse(text)).valid).toBe(true);
  });
});

describe('scaffolded agent role states the merge settings (AISDLC-1351)', () => {
  it('every tier writes the three keys and the resolver reads back the constant', () => {
    for (const tier of ['coding', 'research', 'meta'] as const) {
      const text = renderAgentRole(tier);
      expect(text).toContain('allowMerge:');
      expect(text).toContain('mergeAuthors:');
      expect(text).toContain('operational:');
      const p = parseOperationalPolicy(text);
      expect(p.allowMerge).toBe(AGENT_ROLE_MERGE_DEFAULTS.allowMerge);
      expect(p.mergeAuthors).toEqual([...AGENT_ROLE_MERGE_DEFAULTS.mergeAuthors]);
      expect([...p.operational]).toEqual([...AGENT_ROLE_MERGE_DEFAULTS.operational]);
    }
  });

  it('writes a non-empty constant as lists', () => {
    const text = renderAgentRoleGovernance({
      allowMerge: 'onGreenClean',
      mergeAuthors: ['octo'],
      operational: ['land-eligible-prs'],
    });
    expect(text).toContain('      - octo');
    expect(text).toContain('      - land-eligible-prs');
  });
});

describe('knowledge store scaffold (AISDLC-1408)', () => {
  it('init on an empty project writes context.yaml and the knowledge README; a re-run keeps an edited context.yaml', async () => {
    const res = await scaffoldConfig({ projectDir: dir, defaults: answers });
    expect(res.created).toContain('.ai-sdlc/context.yaml');
    expect(res.created).toContain('.ai-sdlc/knowledge/README.md');
    const ctx = join(dir, '.ai-sdlc/context.yaml');
    expect(existsSync(join(dir, '.ai-sdlc/knowledge/README.md'))).toBe(true);
    writeFileSync(ctx, 'knowledge:\n  trackedRoot: docs/knowledge\n');
    const again = await scaffoldConfig({ projectDir: dir, defaults: answers });
    expect(again.skipped).toContain('.ai-sdlc/context.yaml');
    expect(readFileSync(ctx, 'utf8')).toBe('knowledge:\n  trackedRoot: docs/knowledge\n');
  });

  it('the scaffolded context.yaml loads to the same config as no file', async () => {
    const bare = { knowledge: loadKnowledgeConfig(dir), retrieval: loadRetrievalConfig(dir) };
    await scaffoldConfig({ projectDir: dir, defaults: answers });
    expect(existsSync(join(dir, '.ai-sdlc/context.yaml'))).toBe(true);
    expect({ knowledge: loadKnowledgeConfig(dir), retrieval: loadRetrievalConfig(dir) }).toEqual(
      bare,
    );
  });

  it('the knowledge README is not validated as an entry', async () => {
    await scaffoldConfig({ projectDir: dir, defaults: answers });
    const report = validateKnowledge(dir);
    expect(report.errors).toEqual([]);
    expect(report.entries).toBe(0);
  });

  it('neither entry is required', () => {
    const ids = missingConfigEntries(dir).map((m) => m.id);
    expect(ids).not.toContain('context');
    expect(ids).not.toContain('knowledge-readme');
  });
});

describe('agent-role merge settings from scaffold answers (AISDLC-1384)', () => {
  const role = REQUIRED_CONFIG_MANIFEST.find((e) => e.id === 'agent-role')!;

  it('renders onGreenClean with the merge author and operational list', () => {
    const text = role.render({
      allowMerge: 'onGreenClean',
      mergeAuthors: 'octo',
      operational: AGENT_MERGE_YES_OPERATIONAL.join(','),
    });
    const p = parseOperationalPolicy(text);
    expect(p.allowMerge).toBe('onGreenClean');
    expect(p.mergeAuthors).toEqual(['octo']);
    expect([...p.operational]).toEqual(['land-eligible-prs']);
  });

  it('never renders onGreenClean with an empty author list', () => {
    expect(agentRoleMergeFromAnswers({ allowMerge: 'onGreenClean', mergeAuthors: ' , ' })).toBe(
      AGENT_ROLE_MERGE_DEFAULTS,
    );
    expect(agentRoleMergeFromAnswers({})).toBe(AGENT_ROLE_MERGE_DEFAULTS);
  });
});
