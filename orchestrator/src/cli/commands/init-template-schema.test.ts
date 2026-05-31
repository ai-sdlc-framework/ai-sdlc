/**
 * AISDLC-245.5 — Init template schema validation.
 *
 * Asserts that the `pipeline.yaml` template the `ai-sdlc init` scaffold writes
 * (a) parses as YAML, and (b) validates against the canonical Pipeline schema
 * including the new `spec.backlog` BacklogConfig section.
 *
 * Why this exists: the test reviewer flagged that the migration moved settings
 * into a new schema location but the init template was not validated against
 * that schema in any test. Without this guard, a future edit to `PIPELINE_YAML`
 * could ship adopters a pipeline.yaml the validator rejects on first run.
 *
 * AISDLC-434 addition: signal-ingestion template YAML parse + default-value
 * assertions for all 5 OQ-refinement blocks (RFC-0030 §13.1..13.5 v0.3
 * re-walkthrough). Prevents regressions where edits to SIGNAL_INGESTION_CONFIG_STUB
 * ship adopters a YAML the orchestrator loader rejects on first parse.
 */
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validate } from '@ai-sdlc/reference';
import { PIPELINE_YAML } from './init.js';
import { SIGNAL_INGESTION_CONFIG_STUB } from './init-templates.js';
import {
  loadSignalIngestionConfig,
  DEFAULT_SIGNAL_INGESTION_CONFIG,
} from '../../signal-ingestion/config.js';

describe('AISDLC-245.5 — init pipeline.yaml template schema validation', () => {
  it('PIPELINE_YAML template parses as YAML', () => {
    const doc = parseYaml(PIPELINE_YAML);
    expect(doc).toBeDefined();
    expect(doc.kind).toBe('Pipeline');
    expect(doc.apiVersion).toBe('ai-sdlc.io/v1alpha1');
  });

  it('PIPELINE_YAML template validates against the Pipeline schema (canonical, with spec.backlog)', () => {
    const doc = parseYaml(PIPELINE_YAML);
    const result = validate('Pipeline', doc);
    if (!result.valid) {
      throw new Error(
        `PIPELINE_YAML init template failed schema validation:\n` +
          (result.errors ?? []).map((e) => `  ${e.path}: ${e.message}`).join('\n'),
      );
    }
    expect(result.valid).toBe(true);
  });

  it('PIPELINE_YAML template includes the canonical spec.backlog section (AISDLC-245.5)', () => {
    const doc = parseYaml(PIPELINE_YAML);
    expect(doc.spec.backlog).toBeDefined();
    expect(doc.spec.backlog.branching).toBeDefined();
    expect(doc.spec.backlog.branching.pattern).toBe('ai-sdlc/{issueIdLower}-{slug}');
    expect(doc.spec.backlog.pullRequest).toBeDefined();
    expect(doc.spec.backlog.pullRequest.titleTemplate).toBe('feat: {issueTitle} ({issueId})');
  });

  it('PIPELINE_YAML template does NOT carry the deprecated top-level pipeline-backlog shape', () => {
    const doc = parseYaml(PIPELINE_YAML);
    // Top-level `branching:` / `pullRequest:` keys would mean we shipped the
    // deprecated pipeline-backlog.yaml shape inside pipeline.yaml — that's a
    // misconfiguration we want to fail loud on.
    expect(doc.branching).toBeUndefined();
    expect(doc.pullRequest).toBeUndefined();
  });
});

/**
 * AISDLC-434 — Signal-ingestion init template YAML parse + default-value assertions.
 *
 * Verifies that SIGNAL_INGESTION_CONFIG_STUB:
 *   1. Parses as valid YAML (no syntax errors).
 *   2. After stripping comment-only lines, produces a valid SignalIngestionConfig
 *      envelope with the expected envelope fields.
 *   3. When fed through the orchestrator config loader, resolves to the canonical
 *      DEFAULT_SIGNAL_INGESTION_CONFIG defaults — confirming all 5 OQ-refinement
 *      blocks (§13.1..§13.5 v0.3) are reflected in the loader's defaults.
 *
 * The stub ships with all optional fields commented out — the loader MUST fill
 * every missing field from DEFAULT_SIGNAL_INGESTION_CONFIG. If a default drifts
 * from what the stub documents, this test surfaces the regression.
 */
describe('AISDLC-434 — signal-ingestion init template YAML validation', () => {
  it('SIGNAL_INGESTION_CONFIG_STUB parses as valid YAML', () => {
    const doc = parseYaml(SIGNAL_INGESTION_CONFIG_STUB);
    expect(doc).toBeDefined();
    expect(doc.apiVersion).toBe('ai-sdlc.io/v1alpha1');
    expect(doc.kind).toBe('SignalIngestionConfig');
    expect(doc.spec).toBeDefined();
    // Master switch must default to false in the template
    expect(doc.spec.enabled).toBe(false);
  });

  it('SIGNAL_INGESTION_CONFIG_STUB has all commented-out optional blocks documented in stub comments', () => {
    // Verify that the stub's comment-only sections reference all 5 OQ refinements.
    // This guards against accidental deletion of the refinement documentation.
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('OQ-13.1');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('OQ-13.2');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('OQ-13.3');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('OQ-13.4');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('OQ-13.5');
  });

  it('SIGNAL_INGESTION_CONFIG_STUB documents the full v1 adapter list (OQ-13.1 refinement)', () => {
    // All four v1 adapters must be listed (as comments) in the stub.
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('signal-source-support-ticket');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('signal-source-community-thread');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('signal-source-in-app-feedback');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('signal-source-manual');
  });

  it('SIGNAL_INGESTION_CONFIG_STUB documents franc language detection (OQ-13.2 refinement)', () => {
    // The franc library and acceptedLanguages field must be documented.
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('franc');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('acceptedLanguages');
  });

  it('SIGNAL_INGESTION_CONFIG_STUB documents residencyEnforcement block (OQ-13.3 refinement)', () => {
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('residencyEnforcement');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('fetchSignals');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('clustering');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('multiPostureBehavior');
  });

  it('SIGNAL_INGESTION_CONFIG_STUB documents manualEntry block (OQ-13.4 refinement)', () => {
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('manualEntry');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('dailyCapPerOperator');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('evidenceUrl');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('qualityMetric');
  });

  it('SIGNAL_INGESTION_CONFIG_STUB documents flooding block (OQ-13.5 refinement)', () => {
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('flooding');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('z-score');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('zScoreThreshold');
    expect(SIGNAL_INGESTION_CONFIG_STUB).toContain('quarantine');
  });

  it('loader resolves SIGNAL_INGESTION_CONFIG_STUB to defaults matching DEFAULT_SIGNAL_INGESTION_CONFIG', async () => {
    // The stub ships all optional fields commented out — the loader must fill
    // every missing field from DEFAULT_SIGNAL_INGESTION_CONFIG. We verify by
    // writing the stub to a temp file and loading it through the config loader.
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tempDir = mkdtempSync(join(tmpdir(), 'aisdlc-434-'));
    const aiSdlcDir = join(tempDir, '.ai-sdlc');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(aiSdlcDir, { recursive: true });
    writeFileSync(join(aiSdlcDir, 'signal-ingestion.yaml'), SIGNAL_INGESTION_CONFIG_STUB, 'utf-8');

    try {
      const config = loadSignalIngestionConfig({ projectRoot: tempDir });

      // enabled must be false (the stub explicitly sets this)
      expect(config.enabled).toBe(false);

      // Verify OQ-13.1 defaults: all 3 env-var adapters in v1 scope
      expect(config.adapters).toContain('signal-source-support-ticket');
      expect(config.adapters).toContain('signal-source-community-thread');
      expect(config.adapters).toContain('signal-source-in-app-feedback');

      // Verify OQ-13.2 defaults: English-only
      expect(config.acceptedLanguages).toEqual(['en']);

      // Verify OQ-13.3 defaults: all enforcement points ON
      expect(config.residencyEnforcement.sourceFromCompliancePosture).toBe(true);
      expect(config.residencyEnforcement.enforcementPoints.fetchSignals).toBe(true);
      expect(config.residencyEnforcement.enforcementPoints.clustering).toBe(true);
      expect(config.residencyEnforcement.enforcementPoints.storage).toBe(true);
      expect(config.residencyEnforcement.enforcementPoints.unifiedCostReport).toBe(true);
      expect(config.residencyEnforcement.multiPostureBehavior).toBe('union');

      // Verify OQ-13.4 defaults: daily cap + evidence optional + quality metric ON
      expect(config.manualEntry.dailyCapPerOperator).toBe(
        DEFAULT_SIGNAL_INGESTION_CONFIG.manualEntry.dailyCapPerOperator,
      );
      expect(config.manualEntry.evidenceUrlOptional).toBe(true);
      expect(config.manualEntry.qualityMetric.enabled).toBe(true);
      expect(config.manualEntry.qualityMetric.shareWarningThreshold).toBe(
        DEFAULT_SIGNAL_INGESTION_CONFIG.manualEntry.qualityMetric.shareWarningThreshold,
      );

      // Verify OQ-13.5 defaults: z-score detector + quarantine
      expect(config.flooding.detection.zScoreThreshold).toBe(
        DEFAULT_SIGNAL_INGESTION_CONFIG.flooding.detection.zScoreThreshold,
      );
      expect(config.flooding.detection.windowMinutes).toBe(
        DEFAULT_SIGNAL_INGESTION_CONFIG.flooding.detection.windowMinutes,
      );
      expect(config.flooding.quarantine.enabled).toBe(true);
      expect(config.flooding.quarantine.durationHours).toBe(
        DEFAULT_SIGNAL_INGESTION_CONFIG.flooding.quarantine.durationHours,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
