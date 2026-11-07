import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  checkPolicyConsistency,
  writeConsistencyArtefact,
  DEFAULT_MAX_POLICY_VARIABLES,
} from './policy-consistency.js';
import { validateYaml } from './validator.js';

const autonomy = (allow: string, block: string) => `
kind: AutonomyPolicy
metadata: { name: p }
spec:
  levels:
    - level: 1
      permissions: { read: ['**'], write: ['${allow}'] }
      guardrails: { blockedPaths: ['${block}'] }
`;

const gates = (n: number, extra = '', levels = '') => {
  const flags = Array.from({ length: n }, (_, i) => `f${i}`);
  return `
kind: QualityGate
metadata: { name: g }
spec:
  ${levels}
  gates:
    - { name: a, enforcement: advisory, when: [${flags.join(', ')}] }
${extra}`;
};

describe('policy consistency', () => {
  it('flags a contradicting autonomy pair with both ids and a witness', () => {
    const r = validateYaml({ text: autonomy('src/**', 'src/**') });
    expect(r.valid).toBe(false);
    const f = r.consistencyArtefact!.findings[0];
    expect(f.ruleIds).toEqual([
      'levels[1].permissions.write[0]',
      'levels[1].guardrails.blockedPaths[0]',
    ]);
    expect(f.witness.path).toBe('src/x/x');
    expect(r.issues[0].message).toContain('blockedPaths[0]');
  });

  it('passes a broad allow with a narrower block', () => {
    expect(validateYaml({ text: autonomy('src/**', '.ai-sdlc/**') }).valid).toBe(true);
  });

  it('flags an unreachable enforce level', () => {
    const text = gates(
      0,
      '    - { name: e, enforcement: enforce, when: [x, "!x"] }',
      'enforcementLevels: [advisory, enforce]',
    );
    const r = validateYaml({ text });
    expect(r.valid).toBe(false);
    expect(r.issues[0].message).toContain('"enforce"');
    expect(r.consistencyArtefact!.findings[0].kind).toBe('unreachable-level');
  });

  it('flags a level no gate declares, and a level reachable via a satisfiable gate passes', () => {
    const bad = checkPolicyConsistency('QualityGate', {
      spec: { enforcementLevels: ['hard'], gates: [{ name: 'a', enforcement: 'soft' }] },
    });
    expect(bad!.findings[0].message).toContain('"hard"');
    const noGate = checkPolicyConsistency('QualityGate', {
      spec: {
        enforcementLevels: ['hard'],
        gates: [{ name: 'a', enforcement: 'hard', when: ['x', '!y'] }],
      },
    });
    expect(noGate!.findings).toEqual([]);
  });

  it('fails 21 variables naming maxPolicyVariables; 20 passes fast', () => {
    const r21 = validateYaml({ text: gates(21) });
    expect(r21.valid).toBe(false);
    expect(r21.issues[0].message).toContain('maxPolicyVariables');
    const start = Date.now();
    const r20 = validateYaml({ text: gates(20) });
    expect(r20.valid).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('honours an explicit maxPolicyVariables and falls back on a bad one', () => {
    const t = (v: unknown) =>
      checkPolicyConsistency('QualityGate', {
        spec: { maxPolicyVariables: v, gates: [{ name: 'a', enforcement: 'x', when: ['p', 'q'] }] },
      })!.findings;
    expect(t(1)[0].kind).toBe('too-many-variables');
    expect(t('bad')).toEqual([]);
    expect(DEFAULT_MAX_POLICY_VARIABLES).toBe(20);
  });

  it('ignores other kinds and malformed input', () => {
    expect(checkPolicyConsistency('Pipeline', { spec: {} })).toBeNull();
    expect(checkPolicyConsistency('QualityGate', null)).toBeNull();
    expect(
      checkPolicyConsistency('AutonomyPolicy', { spec: { levels: [1, { level: 0 }] } })!.findings,
    ).toEqual([]);
    expect(
      checkPolicyConsistency('QualityGate', { spec: { gates: [1, { enforcement: 'a' }] } })!
        .findings,
    ).toEqual([]);
  });

  it('writes the artefact', () => {
    const art = checkPolicyConsistency(
      'AutonomyPolicy',
      JSON.parse(JSON.stringify({ spec: { levels: [] } })),
    )!;
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'pc-')), 'compliance');
    const file = writeConsistencyArtefact(dir, art);
    expect(JSON.parse(readFileSync(file, 'utf-8')).kind).toBe('AutonomyPolicy');
  });
});
