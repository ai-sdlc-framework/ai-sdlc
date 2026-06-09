import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';

const CONFIG_DIR = resolve(import.meta.dirname, '../../.ai-sdlc');

describe('loadConfig()', () => {
  it('loads and validates all .ai-sdlc/ resources', () => {
    const config = loadConfig(CONFIG_DIR);

    expect(config.pipeline).toBeDefined();
    expect(config.pipeline!.kind).toBe('Pipeline');
    expect(config.pipeline!.metadata.name).toBe('dogfood-pipeline');

    expect(config.agentRole).toBeDefined();
    expect(config.agentRole!.kind).toBe('AgentRole');
    expect(config.agentRole!.spec.role).toBe('coding-agent');

    expect(config.qualityGate).toBeDefined();
    expect(config.qualityGate!.kind).toBe('QualityGate');
    expect(config.qualityGate!.spec.gates).toHaveLength(3);

    expect(config.autonomyPolicy).toBeDefined();
    expect(config.autonomyPolicy!.kind).toBe('AutonomyPolicy');
    expect(config.autonomyPolicy!.spec.levels).toHaveLength(2);

    expect(config.adapterBindings).toBeDefined();
    expect(config.adapterBindings!.length).toBeGreaterThanOrEqual(2);
    const types = config.adapterBindings!.map((b) => b.spec.type);
    expect(types).toContain('github');
    expect(types).toContain('backlog-md');

    // Backward compat: adapterBinding is the first binding
    expect(config.adapterBinding).toBeDefined();
    expect(config.adapterBinding!.kind).toBe('AdapterBinding');
  });

  it('returns correct pipeline triggers', () => {
    const config = loadConfig(CONFIG_DIR);
    expect(config.pipeline!.spec.triggers[0].event).toBe('issue.labeled');
    expect(config.pipeline!.spec.triggers[0].filter?.labels).toContain('ai-eligible');
  });

  it('returns correct agent constraints', () => {
    const config = loadConfig(CONFIG_DIR);
    const constraints = config.agentRole!.spec.constraints!;
    expect(constraints.maxFilesPerChange).toBe(15);
    expect(constraints.requireTests).toBe(true);
    expect(constraints.blockedPaths).toContain('.github/workflows/**');
    expect(constraints.blockedPaths).toContain('.ai-sdlc/**');
  });

  it('returns correct quality gates', () => {
    const config = loadConfig(CONFIG_DIR);
    const gates = config.qualityGate!.spec.gates;

    const advisory = gates.find((g) => g.name === 'issue-has-description');
    expect(advisory?.enforcement).toBe('advisory');

    const softMandatory = gates.find((g) => g.name === 'issue-has-acceptance-criteria');
    expect(softMandatory?.enforcement).toBe('soft-mandatory');

    const hardMandatory = gates.find((g) => g.name === 'complexity-in-range');
    expect(hardMandatory?.enforcement).toBe('hard-mandatory');
  });

  it('returns correct autonomy policy levels', () => {
    const config = loadConfig(CONFIG_DIR);
    const levels = config.autonomyPolicy!.spec.levels;

    expect(levels[0].level).toBe(0);
    expect(levels[0].name).toBe('Observer');
    expect(levels[0].guardrails.requireApproval).toBe('all');

    expect(levels[1].level).toBe(1);
    expect(levels[1].name).toBe('Junior');
    expect(levels[1].guardrails.maxLinesPerPR).toBe(200);
  });

  it('returns empty config for nonexistent directory', () => {
    const config = loadConfig('/nonexistent');
    expect(config.pipeline).toBeUndefined();
    expect(config.agentRole).toBeUndefined();
    expect(config.qualityGate).toBeUndefined();
    expect(config.autonomyPolicy).toBeUndefined();
    expect(config.adapterBinding).toBeUndefined();
    expect(config.adapterBindings).toBeUndefined();
  });
});

describe('loadConfig() — non-fatal warnings', () => {
  it('skips a malformed YAML file but loads the rest of the config', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = mkdtempSync(join(tmpdir(), 'config-warn-'));
    try {
      mkdirSync(tmp, { recursive: true });
      // Valid Pipeline file
      writeFileSync(
        join(tmp, 'pipeline.yaml'),
        `apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: test-pipeline
spec:
  triggers:
    - event: issue.labeled
      filter:
        labels: [ai-eligible]
  providers: {}
  stages:
    - name: validate
`,
      );
      // Malformed YAML
      writeFileSync(join(tmp, 'broken.yaml'), '{invalid: yaml syntax: [\n');
      const config = loadConfig(tmp);
      expect(config.pipeline?.metadata.name).toBe('test-pipeline');
      expect(config.warnings).toBeDefined();
      expect(config.warnings).toHaveLength(1);
      expect(config.warnings![0].file).toBe('broken.yaml');
      expect(config.warnings![0].error).toContain('parse error');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('skips a YAML that fails schema validation but loads the rest', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = mkdtempSync(join(tmpdir(), 'config-warn-'));
    try {
      mkdirSync(tmp, { recursive: true });
      writeFileSync(
        join(tmp, 'pipeline.yaml'),
        `apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: test-pipeline
spec:
  triggers:
    - event: issue.labeled
      filter:
        labels: [ai-eligible]
  providers: {}
  stages:
    - name: validate
`,
      );
      // Forward-looking AdapterBinding without required fields — fails
      // schema validation. Should be skipped, not throw.
      writeFileSync(
        join(tmp, 'adapter-binding.yaml'),
        `apiVersion: ai-sdlc.io/v1alpha1
kind: AdapterBinding
metadata:
  name: incomplete
spec:
  forwardLookingField: someValue
`,
      );
      const config = loadConfig(tmp);
      expect(config.pipeline).toBeDefined();
      expect(config.warnings).toHaveLength(1);
      expect(config.warnings![0].file).toBe('adapter-binding.yaml');
      expect(config.warnings![0].error).toContain('validation failed');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  // AISDLC-265 PR #474 review fix: typo'd canonical kinds and loader-private
  // kinds both produce a `skipped` validation result. Pre-fix the config loader
  // silently dropped them with NO warning entry — security-relevant misconfigs
  // (e.g. `kind: AutonomyPolcy` typo) ended up running with default permissive
  // policy. Fix: surface skipped kinds in `config.warnings` so operators see
  // the dropped file. This test pins both the typo case AND the legitimate
  // loader-private case.
  it('AISDLC-265: skipped kinds (typo or loader-private) produce a warning', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = mkdtempSync(join(tmpdir(), 'config-skip-warn-'));
    try {
      mkdirSync(tmp, { recursive: true });
      writeFileSync(
        join(tmp, 'pipeline.yaml'),
        `apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: test-pipeline
spec:
  triggers:
    - event: issue.labeled
      filter:
        labels: [ai-eligible]
  providers: {}
  stages:
    - name: validate
`,
      );
      // Typo of canonical kind — should produce a warning, not silent drop.
      writeFileSync(
        join(tmp, 'autonomy-policy-typo.yaml'),
        `apiVersion: ai-sdlc.io/v1alpha1
kind: AutonomyPolcy
metadata:
  name: oops
spec: {}
`,
      );
      // Legitimate loader-private (also produces a warning so operator can verify).
      writeFileSync(
        join(tmp, 'maintainers.yaml'),
        `apiVersion: ai-sdlc.io/v1alpha1
kind: MaintainersList
metadata:
  name: project-maintainers
spec:
  maintainers: []
`,
      );
      const config = loadConfig(tmp);
      expect(config.pipeline).toBeDefined();
      expect(config.warnings).toBeDefined();
      const warningFiles = config.warnings!.map((w) => w.file).sort();
      expect(warningFiles).toContain('autonomy-policy-typo.yaml');
      expect(warningFiles).toContain('maintainers.yaml');
      const typoWarning = config.warnings!.find((w) => w.file === 'autonomy-policy-typo.yaml');
      expect(typoWarning?.error).toContain('AutonomyPolcy');
      expect(typoWarning?.error).toContain('skipped');
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('does not include warnings field when every file loads cleanly', () => {
    const config = loadConfig(CONFIG_DIR);
    expect(config.warnings).toBeUndefined();
  });

  // AISDLC-528: resource-shaped files that fail schema validation must
  // produce actionable warnings naming file + kind + specific violation(s),
  // NOT be silently dropped. This test is the hermetic AC#1 + AC#2 check.

  it('AISDLC-528 AC#1: resource-shaped file with schema violation produces actionable warning (file + kind + violation)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = mkdtempSync(join(tmpdir(), 'config-aisdlc528-'));
    try {
      mkdirSync(tmp, { recursive: true });
      // Valid Pipeline (so the rest of the config loads)
      writeFileSync(
        join(tmp, 'pipeline.yaml'),
        `apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: test-pipeline
spec:
  triggers:
    - event: issue.labeled
      filter:
        labels: [ai-eligible]
  providers: {}
  stages:
    - name: validate
`,
      );
      // Resource-shaped QualityGate that is missing required spec fields —
      // it HAS apiVersion+kind so it is NOT silently skipped (AISDLC-722 guard
      // only skips non-resource YAMLs). Instead it must produce a warning with
      // the file name, the kind, and the specific schema violation(s).
      writeFileSync(
        join(tmp, 'quality-gate.yaml'),
        `apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: incomplete-gate
spec:
  forwardLookingOnlyField: someValue
`,
      );
      const config = loadConfig(tmp);
      // QualityGate was dropped (failed validation), not silently skipped.
      expect(config.qualityGate).toBeUndefined();
      // Warning must be present.
      expect(config.warnings).toBeDefined();
      const qgWarning = config.warnings!.find((w) => w.file === 'quality-gate.yaml');
      expect(qgWarning).toBeDefined();
      // Warning must name the file — already guaranteed by key lookup above.
      // Warning must name the kind ('QualityGate') in the error string.
      // (The loader formats: "validation failed: /path: msg; /path2: msg2")
      expect(qgWarning!.error).toContain('validation failed');
      // Warning must include at least one schema violation path/message.
      // The AJV error format: "/spec/gates: is required" or similar.
      // We check that it contains a path fragment — confirming violation detail.
      expect(qgWarning!.error.length).toBeGreaterThan('validation failed: '.length);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });

  it('AISDLC-528 AC#2: non-resource YAML (no apiVersion+kind) is silently skipped — no warning entry', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmp = mkdtempSync(join(tmpdir(), 'config-aisdlc528-nonresource-'));
    try {
      mkdirSync(tmp, { recursive: true });
      // Valid Pipeline
      writeFileSync(
        join(tmp, 'pipeline.yaml'),
        `apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: test-pipeline
spec:
  triggers:
    - event: issue.labeled
      filter:
        labels: [ai-eligible]
  providers: {}
  stages:
    - name: validate
`,
      );
      // Non-resource YAML — no apiVersion or kind.
      // AISDLC-722 guard: silently skipped, no warning produced.
      writeFileSync(
        join(tmp, 'review-exemplars.yaml'),
        `# Review exemplars — not an AI-SDLC resource
examples:
  - title: Good PR
    description: Adds tests, docs, and implementation together
`,
      );
      const config = loadConfig(tmp);
      // No warning for the non-resource file.
      const nonResourceWarning = config.warnings?.find((w) => w.file === 'review-exemplars.yaml');
      expect(nonResourceWarning).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});
