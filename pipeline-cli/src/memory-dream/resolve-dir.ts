/**
 * Resolve the memory folder the way sessions do (AISDLC-729): the
 * `autoMemoryDirectory` setting (project local, project, then user settings),
 * else the harness default `~/.claude/projects/<slug>/memory`.
 *
 * @module memory-dream/resolve-dir
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function projectSlug(projectDir: string): string {
  return resolve(projectDir).replace(/[^A-Za-z0-9]/g, '-');
}

function readSetting(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    const v = (parsed as { autoMemoryDirectory?: unknown } | null)?.autoMemoryDirectory;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function resolveMemoryDir(opts: { projectDir: string; home?: string }): string {
  const home = opts.home ?? homedir();
  const candidates = [
    join(opts.projectDir, '.claude', 'settings.local.json'),
    join(opts.projectDir, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.json'),
  ];
  for (const file of candidates) {
    const v = readSetting(file);
    if (!v) continue;
    if (v === '~') return home;
    if (v.startsWith('~/')) return join(home, v.slice(2));
    return isAbsolute(v) ? v : resolve(opts.projectDir, v);
  }
  return join(home, '.claude', 'projects', projectSlug(opts.projectDir), 'memory');
}
