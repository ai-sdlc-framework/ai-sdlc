import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { validate, BUILT_IN_CAPABILITIES } from '@ai-sdlc/reference';
import { BASELINE_WORKFLOW_TEMPLATES, CAPABILITIES_CONFIG_TEMPLATE } from './init-templates.js';

describe('capabilities.yaml init template', () => {
  const key = '.ai-sdlc/templates/capabilities.yaml';

  it('is in the init template map', () => {
    expect(BASELINE_WORKFLOW_TEMPLATES.files[key]).toBe(CAPABILITIES_CONFIG_TEMPLATE);
  });

  it('validates against the schema with an empty required list', () => {
    const doc = parseYaml(CAPABILITIES_CONFIG_TEMPLATE);
    expect(doc.spec.required).toEqual([]);
    const result = validate('CapabilitiesConfig', doc);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('carries no internal task ids', () => {
    expect(CAPABILITIES_CONFIG_TEMPLATE).not.toMatch(/AISDLC-\d+/);
  });
});

describe('repository .ai-sdlc/capabilities.yaml', () => {
  const file = resolve(__dirname, '../../../../.ai-sdlc/capabilities.yaml');
  const doc = parseYaml(readFileSync(file, 'utf8'));

  it('validates against the schema and lists eight registered capabilities', () => {
    expect(validate('CapabilitiesConfig', doc).valid).toBe(true);
    expect(doc.spec.required).toHaveLength(8);
    const registered = new Set(BUILT_IN_CAPABILITIES.map((c) => c.id));
    for (const id of doc.spec.required) expect(registered.has(id)).toBe(true);
  });
});
