import { TASK_CLASSES } from '../estimation/types.js';

/**
 * The estimation class recorded in a task file's frontmatter `class:` field,
 * or 'uncategorized' when none is recorded (or the value is not a known class).
 */
export function taskClassOf(rawBody: string | undefined): string {
  if (!rawBody) return 'uncategorized';
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(rawBody);
  if (!fm) return 'uncategorized';
  const m = /^class:\s*['"]?([A-Za-z-]+)['"]?\s*$/m.exec(fm[1]);
  const value = m?.[1].toLowerCase();
  return value && (TASK_CLASSES as readonly string[]).includes(value) ? value : 'uncategorized';
}
