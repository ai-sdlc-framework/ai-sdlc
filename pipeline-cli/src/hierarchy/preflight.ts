/**
 * Preflight checks for `cli-hierarchy up`: the cross-session inbound setting
 * and the machine resource gate.
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';

import type { CommandRunner, ResourceSnapshot } from './types.js';

/** Minimum available memory before another session may start: 4 GiB. */
export const MIN_AVAILABLE_BYTES = 4 * 1024 * 1024 * 1024;

/** The value the bypass tiers need so lower-tier messages are delivered. */
export const REQUIRED_INBOUND_VALUE = 'accept';

/** Environment variable that skips the resource gate (testing escape hatch). */
export const SKIP_RESOURCE_GATE_ENV = 'AI_SDLC_EXECUTE_PARALLEL_SKIP_RESOURCE_GATE';

/** Effective values read from the layered Claude Code settings files. */
export interface SettingsView {
  /** Effective `crossSessionInbound`, or undefined when no layer sets it. */
  crossSessionInbound?: unknown;
  /** Effective `permissions.defaultMode`, or undefined when no layer sets it. */
  defaultMode?: string;
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge settings files in precedence order (lowest first; a later file wins).
 * Unreadable or non-object files are ignored.
 */
export function readSettingsView(settingsFiles: readonly string[]): SettingsView {
  const view: SettingsView = {};
  for (const file of settingsFiles) {
    const doc = readJsonObject(file);
    if (!doc) continue;
    if ('crossSessionInbound' in doc) view.crossSessionInbound = doc.crossSessionInbound;
    const perms = doc.permissions;
    if (typeof perms === 'object' && perms !== null) {
      const mode = (perms as Record<string, unknown>).defaultMode;
      if (typeof mode === 'string') view.defaultMode = mode;
    }
  }
  return view;
}

/** Outcome of the inbound-setting check. */
export interface InboundCheck {
  ok: boolean;
  /** Human-readable instructions when `ok` is false. */
  message?: string;
}

/**
 * Check that the settings in force include `crossSessionInbound: "accept"`.
 * `userSettingsFile` is named in the instructions as the file to edit.
 */
export function checkCrossSessionInbound(
  view: SettingsView,
  userSettingsFile: string,
  projectLocalSettingsFile = '.claude/settings.local.json',
): InboundCheck {
  if (view.crossSessionInbound === REQUIRED_INBOUND_VALUE) return { ok: true };
  const current =
    view.crossSessionInbound === undefined
      ? 'is not set'
      : `is set to ${JSON.stringify(view.crossSessionInbound)}`;
  const message = [
    `crossSessionInbound ${current}; the dispatch and executor sessions need "accept" so messages from the other tiers are delivered instead of held for approval.`,
    '',
    `Add this to ${projectLocalSettingsFile} (project-local, recommended), or alternatively to ${userSettingsFile} (user-global), then run the command again:`,
    '',
    '  {',
    `    "crossSessionInbound": "${REQUIRED_INBOUND_VALUE}"`,
    '  }',
    '',
    'The setting applies to every session that reads that settings file, including the planner. It only controls delivery of messages from other sessions; it does not change tool approvals.',
  ].join('\n');
  return { ok: false, message };
}

/** Parse `vm_stat` output into available bytes (free + inactive + speculative). */
export function parseVmStat(output: string): number | null {
  const pageSizeMatch = /page size of (\d+) bytes/.exec(output);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
  let pages = 0;
  let seen = false;
  for (const label of ['Pages free', 'Pages inactive', 'Pages speculative']) {
    const m = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(output);
    if (m) {
      pages += Number(m[1]);
      seen = true;
    }
  }
  return seen ? pages * pageSize : null;
}

/** Parse `/proc/meminfo` text into available bytes. */
export function parseMemInfo(text: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
  return m ? Number(m[1]) * 1024 : null;
}

/** Measure machine headroom with the real system, via the injected runner for `vm_stat`. */
export function systemResourceSnapshot(run: CommandRunner): ResourceSnapshot {
  let availableBytes: number | null = null;
  if (process.platform === 'darwin') {
    const r = run('vm_stat', []);
    if (r.status === 0) availableBytes = parseVmStat(r.stdout);
  } else if (existsSync('/proc/meminfo')) {
    availableBytes = parseMemInfo(readFileSync('/proc/meminfo', 'utf-8'));
  }
  return { availableBytes, loadAvg1: os.loadavg()[0] ?? 0, cpus: os.cpus().length || 1 };
}

/**
 * Resource gate: refuse when available memory is under 4 GiB or the one-minute
 * load average is at or above the core count. An unmeasurable memory value is
 * not a refusal. Returns an error message, or null when there is headroom.
 */
export function evaluateResourceGate(
  snapshot: ResourceSnapshot,
  env: NodeJS.ProcessEnv = {},
): string | null {
  if (env[SKIP_RESOURCE_GATE_ENV] === '1') return null;
  if (snapshot.availableBytes !== null && snapshot.availableBytes < MIN_AVAILABLE_BYTES) {
    const gb = (snapshot.availableBytes / 1024 ** 3).toFixed(1);
    return `resource gate refused: ${gb} GiB of memory available, at least 4 GiB needed. Set ${SKIP_RESOURCE_GATE_ENV}=1 to override.`;
  }
  if (snapshot.loadAvg1 >= snapshot.cpus) {
    return `resource gate refused: one-minute load average ${snapshot.loadAvg1.toFixed(2)} is at or above the ${snapshot.cpus} available cores. Set ${SKIP_RESOURCE_GATE_ENV}=1 to override.`;
  }
  return null;
}
