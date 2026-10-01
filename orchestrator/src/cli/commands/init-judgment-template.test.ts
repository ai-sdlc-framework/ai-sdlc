import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validate } from '@ai-sdlc/reference';
import { BASELINE_WORKFLOW_TEMPLATES, JUDGMENT_CONFIG_TEMPLATE } from './init-templates.js';

describe('judgment-config.yaml init template', () => {
  const key = '.ai-sdlc/templates/judgment-config.yaml';

  it('is in the init template map', () => {
    expect(BASELINE_WORKFLOW_TEMPLATES.files[key]).toBe(JUDGMENT_CONFIG_TEMPLATE);
  });

  it('is fully commented: parses to nothing as shipped', () => {
    expect(parseYaml(BASELINE_WORKFLOW_TEMPLATES.files[key])).toBeNull();
  });

  it('lists each egress class on its own line', () => {
    for (const c of ['work-item-text', 'code-diff', 'agent-output']) {
      expect(JUDGMENT_CONFIG_TEMPLATE).toMatch(new RegExp(`^#\\s+- ${c}$`, 'm'));
    }
  });

  it('validates against the schema once uncommented', () => {
    const uncommented = BASELINE_WORKFLOW_TEMPLATES.files[key]
      .split('\n')
      .filter((l) => !l.startsWith('##'))
      .map((l) => l.replace(/^# ?/, ''))
      .join('\n');
    const doc = parseYaml(uncommented);
    expect(doc.kind).toBe('JudgmentConfig');
    const result = validate('JudgmentConfig', doc);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('carries no internal task ids', () => {
    expect(JUDGMENT_CONFIG_TEMPLATE).not.toMatch(/AISDLC-\d+/);
  });
});
