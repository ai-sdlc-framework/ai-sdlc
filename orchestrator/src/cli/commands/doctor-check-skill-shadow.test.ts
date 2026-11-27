import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkDecisionRubricShadow } from './doctor-check-skill-shadow.js';
import { DOCTOR_CHECKS, type DoctorCheckAdapters } from './doctor-checks.js';

let tmp: string;
let home: string;
let skills: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'doctor-skill-shadow-'));
  home = join(tmp, 'home');
  skills = join(home, '.claude', 'skills');
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function run() {
  const adapters = { homeDir: () => home } as unknown as DoctorCheckAdapters;
  return checkDecisionRubricShadow({ projectDir: tmp, adapters });
}

function skillDir(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n\n# body\n`);
  return dir;
}

/** A plugin root with `.claude-plugin/` and `skills/decision-rubric/`. */
function pluginRubric(): string {
  const root = join(tmp, 'repo', 'ai-sdlc-plugin');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  return skillDir(join(root, 'skills', 'decision-rubric'), 'decision-rubric');
}

describe('decision-rubric-shadow doctor check (AISDLC-1451)', () => {
  it('is registered', () => {
    expect(DOCTOR_CHECKS.some((c) => c.id === 'decision-rubric-shadow')).toBe(true);
  });

  it('passes with no skills directory', () => {
    expect(run().severity).toBe('pass');
  });

  it('passes a symlink to a plugin skills/decision-rubric directory', () => {
    mkdirSync(skills, { recursive: true });
    symlinkSync(pluginRubric(), join(skills, 'decision-rubric'));
    skillDir(join(skills, 'graphify'), 'graphify');
    expect(run()).toMatchObject({ id: 'decision-rubric-shadow', severity: 'pass' });
  });

  it('warns on a real directory, naming the symlink fix', () => {
    skillDir(join(skills, 'decision-rubric'), 'decision-rubric');
    const r = run();
    expect(r.severity).toBe('warn');
    expect(r.remediation).toMatch(/is a real directory/);
    expect(r.remediation).toMatch(/ln -s <plugin-root>\/skills\/decision-rubric/);
  });

  it('warns on a symlink to anywhere else', () => {
    const other = skillDir(join(tmp, 'elsewhere', 'decision-rubric'), 'decision-rubric');
    mkdirSync(skills, { recursive: true });
    symlinkSync(other, join(skills, 'decision-rubric'));
    const r = run();
    expect(r.severity).toBe('warn');
    expect(r.remediation).toMatch(/is a symlink to .*elsewhere.*not a plugin skill/);
  });

  it('warns on a dangling symlink', () => {
    mkdirSync(skills, { recursive: true });
    symlinkSync(join(tmp, 'gone'), join(skills, 'decision-rubric'));
    expect(run().remediation).toMatch(/a missing target/);
  });

  it('warns on a skills/ directory without .claude-plugin', () => {
    const dir = skillDir(join(tmp, 'notplugin', 'skills', 'decision-rubric'), 'decision-rubric');
    mkdirSync(skills, { recursive: true });
    symlinkSync(dir, join(skills, 'decision-rubric'));
    expect(run().severity).toBe('warn');
  });

  it('warns on another skill directory declaring name: decision-rubric', () => {
    mkdirSync(skills, { recursive: true });
    symlinkSync(pluginRubric(), join(skills, 'decision-rubric'));
    skillDir(join(skills, 'decision-rubric.bak'), 'decision-rubric');
    const r = run();
    expect(r.severity).toBe('warn');
    expect(r.title).toMatch(/^1 personal/);
    expect(r.remediation).toMatch(/decision-rubric\.bak\/SKILL\.md declares name: decision-rubric/);
  });

  it('ignores name: decision-rubric outside the front matter', () => {
    mkdirSync(join(skills, 'notes'), { recursive: true });
    writeFileSync(
      join(skills, 'notes', 'SKILL.md'),
      '---\nname: notes\n---\nname: decision-rubric\n',
    );
    expect(run().severity).toBe('pass');
  });
});
