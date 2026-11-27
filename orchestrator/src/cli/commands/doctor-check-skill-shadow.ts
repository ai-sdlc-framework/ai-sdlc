/**
 * `decision-rubric-shadow` doctor check (AISDLC-1451).
 *
 * A skill in `~/.claude/skills/` with the same name as a plugin skill loads
 * instead of it, so a stale personal copy of the decision rubric silently
 * drops the plugin's research-subagent step (DEC-0442). The one sanctioned
 * entry is a symlink to a plugin `skills/decision-rubric` directory (the
 * operator set one up on 2026-11-27, pointing at the repo copy).
 *
 * Warns when `decision-rubric` is a real directory, a symlink anywhere else,
 * or when another skill directory's `SKILL.md` declares
 * `name: decision-rubric` (a backup left inside `skills/` still loads).
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import type { DoctorCheckResult, DoctorRunContext } from './doctor-checks.js';

const ID = 'decision-rubric-shadow';
const SKILL = 'decision-rubric';
const NAME_LINE = /^name:\s*["']?decision-rubric["']?\s*$/m;

/** True when `target` is a `.../skills/decision-rubric` directory inside a plugin (it has a sibling `.claude-plugin`). */
function isPluginSkillDir(target: string): boolean {
  const suffix = `${sep}skills${sep}${SKILL}`;
  if (!target.endsWith(suffix)) return false;
  const pluginRoot = target.slice(0, -suffix.length);
  try {
    return lstatSync(join(pluginRoot, '.claude-plugin')).isDirectory();
  } catch {
    return false;
  }
}

function declaresRubric(skillDir: string): boolean {
  try {
    const text = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n?/g, '\n'));
    return front !== null && NAME_LINE.test(front[1]);
  } catch {
    return false;
  }
}

export function checkDecisionRubricShadow(ctx: DoctorRunContext): DoctorCheckResult {
  const skillsDir = join(ctx.adapters.homeDir(), '.claude', 'skills');
  const fix = (what: string): string =>
    `${what} shadows the plugin decision-rubric skill. Replace it with a symlink to the plugin copy: move it out of ${skillsDir}, then \`ln -s <plugin-root>/skills/decision-rubric ${join(skillsDir, SKILL)}\` (or delete it and use the plugin skill).`;
  const problems: string[] = [];

  let names: string[];
  try {
    names = readdirSync(skillsDir);
  } catch {
    names = [];
  }

  if (names.includes(SKILL)) {
    const entry = join(skillsDir, SKILL);
    const st = lstatSync(entry);
    if (st.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(entry);
      } catch {
        target = '';
      }
      if (!target || !isPluginSkillDir(target)) {
        problems.push(
          fix(`${entry} is a symlink to ${target || 'a missing target'}, not a plugin skill`),
        );
      }
    } else {
      problems.push(fix(`${entry} is a real ${st.isDirectory() ? 'directory' : 'file'}`));
    }
  }

  for (const name of names) {
    if (name === SKILL) continue;
    const dir = join(skillsDir, name);
    if (declaresRubric(dir)) {
      problems.push(fix(`${dir}/SKILL.md declares name: ${SKILL} and`));
    }
  }

  if (problems.length === 0) {
    return {
      id: ID,
      severity: 'pass',
      title: 'no personal copy of the decision-rubric skill shadows the plugin skill',
    };
  }
  return {
    id: ID,
    severity: 'warn',
    title: `${problems.length} personal decision-rubric skill(s) shadow the plugin skill`,
    remediation: problems.join('\n'),
    anonymizableEvidence: { shadowCount: problems.length },
  };
}
