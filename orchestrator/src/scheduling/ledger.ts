/**
 * SubscriptionLedger per RFC §14.2 / §14.12. Tracks per-(harness, accountId, tenant)
 * window state derived from observed token consumption. Persists per-key state to
 * $ARTIFACTS_DIR/_ledger/<harness>-<accountIdShort>-<tenant>.json so it survives
 * orchestrator restarts within a window.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isOffPeakAt } from './off-peak.js';
import {
  DEFAULT_TENANT,
  type AdmissionDecision,
  type LedgerKey,
  type SubscriptionPlan,
  type TokenEstimate,
  type WindowState,
} from './types.js';

interface PersistedState {
  windowStart: string;
  consumedTokens: number;
}

export interface LedgerDeps {
  now?: () => Date;
  /** Override file IO for tests. */
  io?: {
    read: (path: string) => Promise<string | null>;
    write: (path: string, content: string) => Promise<void>;
  };
}

export class SubscriptionLedger {
  private readonly state = new Map<string, PersistedState>();
  private readonly now: () => Date;
  private readonly io: NonNullable<LedgerDeps['io']>;
  private readonly artifactsDir: string;

  constructor(artifactsDir: string, deps: LedgerDeps = {}) {
    this.artifactsDir = artifactsDir;
    this.now = deps.now ?? (() => new Date());
    this.io = deps.io ?? {
      read: async (p) => {
        try {
          return await readFile(p, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw err;
        }
      },
      write: async (p, c) => {
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, c, 'utf8');
      },
    };
  }

  static keyToString(key: LedgerKey): string {
    return `${key.harness}|${key.accountId}|${key.tenant ?? DEFAULT_TENANT}`;
  }

  static keyToFilename(key: LedgerKey): string {
    const accountIdShort = key.accountId.slice(0, 8);
    const tenant = key.tenant ?? DEFAULT_TENANT;
    return `${key.harness}-${accountIdShort}-${tenant}.json`;
  }

  private filePathFor(key: LedgerKey): string {
    return join(this.artifactsDir, '_ledger', SubscriptionLedger.keyToFilename(key));
  }

  /** Load persisted state for a key (or initialize a fresh window). */
  async load(key: LedgerKey, plan: SubscriptionPlan): Promise<void> {
    const path = this.filePathFor(key);
    const raw = await this.io.read(path);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PersistedState;
        const now = this.now();
        const windowStart = new Date(parsed.windowStart);
        const windowEnd = computeWindowEnd(windowStart, plan);
        if (now.getTime() < windowEnd.getTime()) {
          this.state.set(SubscriptionLedger.keyToString(key), parsed);
          return;
        }
        // Window has expired; reset.
      } catch {
        // Malformed; reset.
      }
    }
    this.state.set(SubscriptionLedger.keyToString(key), {
      windowStart: this.now().toISOString(),
      consumedTokens: 0,
    });
    await this.persist(key);
  }

  windowState(key: LedgerKey, plan: SubscriptionPlan): WindowState {
    const persisted = this.state.get(SubscriptionLedger.keyToString(key));
    if (!persisted)
      throw new Error(`Ledger not loaded for key: ${SubscriptionLedger.keyToString(key)}`);
    const windowStart = new Date(persisted.windowStart);
    const windowEnd = computeWindowEnd(windowStart, plan);
    const multiplier =
      plan.offPeak && isOffPeakAt(plan.offPeak, this.now()) ? plan.offPeak.multiplier : 1.0;
    const quotaTokens = plan.windowQuotaTokens ?? Number.POSITIVE_INFINITY;
    return {
      windowStart,
      windowEnd,
      consumedTokens: persisted.consumedTokens,
      quotaTokens,
      multiplier,
      utilizationFraction:
        quotaTokens === Number.POSITIVE_INFINITY ? 0 : persisted.consumedTokens / quotaTokens,
      pacingTarget: plan.pacingTarget,
      hardCap: plan.hardCap,
    };
  }

  /**
   * Decide whether a stage with the given estimated token cost may admit. Off-peak
   * multiplier reduces the effective cost (2x off-peak → 0.5x quota consumption).
   */
  admit(key: LedgerKey, plan: SubscriptionPlan, estimate: TokenEstimate): AdmissionDecision {
    const ws = this.windowState(key, plan);
    if (plan.billingMode === 'pay-per-token' || ws.quotaTokens === Number.POSITIVE_INFINITY) {
      return { kind: 'yes', reason: 'pay-per-token plan; no quota' };
    }
    const totalEstimate = (estimate.input + estimate.output) / ws.multiplier;
    const wouldConsume = ws.consumedTokens + totalEstimate;
    const projectedFraction = wouldConsume / ws.quotaTokens;
    if (projectedFraction <= plan.hardCap) {
      return {
        kind: 'yes',
        reason: `under hardCap (${projectedFraction.toFixed(3)} ≤ ${plan.hardCap})`,
      };
    }
    return {
      kind: 'no',
      reason: `would exceed hardCap (${projectedFraction.toFixed(3)} > ${plan.hardCap})`,
      blockedBy: 'hardCap',
    };
  }

  async record(
    key: LedgerKey,
    plan: SubscriptionPlan,
    actualTokens: { input: number; output: number },
  ): Promise<void> {
    const persisted = this.state.get(SubscriptionLedger.keyToString(key));
    if (!persisted)
      throw new Error(`Ledger not loaded for key: ${SubscriptionLedger.keyToString(key)}`);
    const multiplier =
      plan.offPeak && isOffPeakAt(plan.offPeak, this.now()) ? plan.offPeak.multiplier : 1.0;
    persisted.consumedTokens += (actualTokens.input + actualTokens.output) / multiplier;
    await this.persist(key);
  }

  isOffPeak(plan: SubscriptionPlan, when?: Date): boolean {
    if (!plan.offPeak) return false;
    return isOffPeakAt(plan.offPeak, when ?? this.now());
  }

  /** Reset the ledger for a key (used by tests + the LedgerReconciliation flow). */
  reset(key: LedgerKey): void {
    this.state.set(SubscriptionLedger.keyToString(key), {
      windowStart: this.now().toISOString(),
      consumedTokens: 0,
    });
  }

  private async persist(key: LedgerKey): Promise<void> {
    const persisted = this.state.get(SubscriptionLedger.keyToString(key));
    if (!persisted) return;
    await this.io.write(this.filePathFor(key), JSON.stringify(persisted));
  }
}

function computeWindowEnd(windowStart: Date, plan: SubscriptionPlan): Date {
  if (plan.billingMode === 'monthly-cap') {
    // Roll at month boundary.
    const next = new Date(windowStart);
    next.setMonth(next.getMonth() + 1);
    return next;
  }
  if (plan.billingMode === 'session-window' && plan.windowDuration) {
    return new Date(windowStart.getTime() + parseIso8601DurationMs(plan.windowDuration));
  }
  // pay-per-token: no window.
  return new Date(windowStart.getTime() + 365 * 24 * 60 * 60 * 1000);
}

/** Minimal ISO 8601 duration parser supporting PT<N>H / PT<N>M / P<N>D combinations. */
function parseIso8601DurationMs(duration: string): number {
  const m = duration.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!m) throw new Error(`Unsupported ISO 8601 duration: ${duration}`);
  const days = Number.parseInt(m[1] ?? '0', 10);
  const hours = Number.parseInt(m[2] ?? '0', 10);
  const minutes = Number.parseInt(m[3] ?? '0', 10);
  return ((days * 24 + hours) * 60 + minutes) * 60 * 1000;
}

/**
 * Tenant-share validation per RFC §14.12. Returns null if valid; otherwise the failed
 * (harness, accountId) groups with their share sums. The orchestrator emits
 * TenantShareInvalid for each failure and refuses to start.
 */
export function validateTenantShares(
  pipelines: ReadonlyArray<{
    name: string;
    harness: string;
    accountId: string;
    tenant?: string;
    tenantQuotaShare?: number;
  }>,
  tolerance: number = 0.001,
): Array<{ harness: string; accountId: string; sumOfShares: number; pipelines: string[] }> {
  const groups = new Map<
    string,
    {
      harness: string;
      accountId: string;
      pipelines: string[];
      shares: Array<number | undefined>;
      tenants: Set<string>;
    }
  >();
  for (const p of pipelines) {
    const key = `${p.harness}|${p.accountId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        harness: p.harness,
        accountId: p.accountId,
        pipelines: [],
        shares: [],
        tenants: new Set(),
      };
      groups.set(key, group);
    }
    group.pipelines.push(p.name);
    group.shares.push(p.tenantQuotaShare);
    if (p.tenant) group.tenants.add(p.tenant);
  }
  const failures: Array<{
    harness: string;
    accountId: string;
    sumOfShares: number;
    pipelines: string[];
  }> = [];
  for (const group of groups.values()) {
    if (group.tenants.size === 0) continue; // all untenanted; no validation needed
    if (group.shares.some((s) => s === undefined)) {
      failures.push({
        harness: group.harness,
        accountId: group.accountId,
        sumOfShares: NaN,
        pipelines: group.pipelines,
      });
      continue;
    }
    const sum = group.shares.reduce((a, b) => (a as number) + (b as number), 0) as number;
    if (Math.abs(sum - 1.0) > tolerance) {
      failures.push({
        harness: group.harness,
        accountId: group.accountId,
        sumOfShares: sum,
        pipelines: group.pipelines,
      });
    }
  }
  return failures;
}
