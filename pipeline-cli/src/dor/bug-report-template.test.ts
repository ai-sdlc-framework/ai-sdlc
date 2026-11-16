import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { evaluateGate1 } from './gates/gate-1-ac-testable.js';

interface FormField {
  type: string;
  id?: string;
  attributes?: { label?: string; value?: string };
  validations?: { required?: boolean };
}

const here = dirname(fileURLToPath(import.meta.url));
const template = resolve(here, '../../../.github/ISSUE_TEMPLATE/bug-report.yml');
const form = load(readFileSync(template, 'utf8')) as { body: FormField[] };

describe('bug-report.yml acceptance criteria field (AISDLC-1287)', () => {
  const field = form.body.find((f) => f.id === 'acceptance-criteria');

  it('is a required textarea with a two-line checklist default', () => {
    expect(field?.type).toBe('textarea');
    expect(field?.attributes?.label).toBe('Acceptance Criteria');
    expect(field?.validations?.required).toBe(true);
    const lines = (field?.attributes?.value ?? '').split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatch(/^- \[ \] \S/);
  });

  it('renders a body with every field at its default that passes gate 1', () => {
    const body = form.body
      .filter((f) => f.attributes?.label)
      .map((f) => `### ${f.attributes?.label}\n\n${f.attributes?.value?.trim() ?? '_No response_'}`)
      .join('\n\n');
    const result = evaluateGate1({ source: 'github', id: '1', title: 'bug', body });
    expect(result.verdict).toBe('pass');
  });
});
