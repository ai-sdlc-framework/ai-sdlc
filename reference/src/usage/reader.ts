/**
 * Streaming reader over the monthly ledger files.
 */

import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isLedgerFile, ledgerFileMonth, resolveUsageDir } from './paths.js';
import type { ModelCallFilter, ModelCallRecord, UsageStoreOptions } from './types.js';

function toMs(v: string | Date | undefined): number | undefined {
  if (v === undefined) return undefined;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
}

function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear().toString().padStart(4, '0')}-${(d.getUTCMonth() + 1)
    .toString()
    .padStart(2, '0')}`;
}

function matches(r: ModelCallRecord, f: ModelCallFilter, fromMs?: number, toMsV?: number): boolean {
  const t = Date.parse(r.ts);
  if (fromMs !== undefined && !(t >= fromMs)) return false;
  if (toMsV !== undefined && !(t < toMsV)) return false;
  if (f.model !== undefined && r.model !== f.model) return false;
  if (f.agentRole !== undefined && r.agentRole !== f.agentRole) return false;
  if (f.scope !== undefined && r.scope !== f.scope) return false;
  if (f.repo !== undefined && r.repo !== f.repo) return false;
  if (f.taskId !== undefined && r.taskId !== f.taskId) return false;
  if (f.billingPool !== undefined && r.billingPool !== f.billingPool) return false;
  return true;
}

/**
 * Stream records matching `filter`, oldest month first. Only month files that
 * can overlap the date range are opened; unparsable lines are skipped.
 */
export async function* readModelCalls(
  filter: ModelCallFilter = {},
  opts: UsageStoreOptions = {},
): AsyncGenerator<ModelCallRecord> {
  const dir = resolveUsageDir(opts);
  if (!existsSync(dir)) return;
  const fromMs = toMs(filter.from);
  const toMsV = toMs(filter.to);
  const fromMonth = fromMs !== undefined ? monthKey(fromMs) : undefined;
  const toMonth = toMsV !== undefined ? monthKey(toMsV) : undefined;

  const files = readdirSync(dir)
    .filter(isLedgerFile)
    .sort()
    .filter((f) => {
      const m = ledgerFileMonth(f);
      if (!m) return false;
      if (fromMonth && m < fromMonth) return false;
      if (toMonth && m > toMonth) return false;
      return true;
    });

  for (const file of files) {
    const rl = createInterface({
      input: createReadStream(join(dir, file), { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec: ModelCallRecord;
      try {
        rec = JSON.parse(line) as ModelCallRecord;
      } catch {
        continue;
      }
      if (matches(rec, filter, fromMs, toMsV)) yield rec;
    }
  }
}
