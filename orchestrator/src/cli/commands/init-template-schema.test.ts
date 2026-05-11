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
 */
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validate } from '@ai-sdlc/reference';
import { PIPELINE_YAML } from './init.js';

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
