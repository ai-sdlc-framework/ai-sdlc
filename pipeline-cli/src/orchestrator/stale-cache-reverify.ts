/**
 * Stale-cache reverify (AISDLC-449).
 *
 * ## Problem — the 18h passive heartbeat (2026-05-26 → 27)
 *
 * After context compaction the orchestrator trusted cached task-summary
 * lines ("blocked on operator sign-off / CI race") without re-investigating
 * actual PR state. The real blocker (a v6 envelope filename issue) was
 * always fixable — but `orchestrator-tick` had no rule that said "if you've
 * been heartbeating with no state change for N ticks, re-investigate the
 * cached blockers." Result: silent rot, against VISION.md §4 ("Honest
 * failure modes — no silent rot").
 *
 * ## What this module provides
 *
 * Pure, hermetic, injection-friendly state logic for a **Step 6.5
 * stale-cache reverify** gate that the `orchestrator-tick` skill body runs
 * just before its final ScheduleWakeup. The skill body owns the GitHub I/O
 * (re-fetching `gh pr checks` details); this module owns:
 *
 *   1. A persisted passive-tick counter (`passive-state.json`) tracking
 *      `consecutiveNoChangeTicks`, a fingerprint of the last observed
 *      blocked-PR state, and the last-observed dispatch count.
 *   2. {@link updatePassiveTickState} — the pure increment/reset decision:
 *      increment when the blocked-PR fingerprint is unchanged AND the
 *      dispatch count is unchanged; reset to 0 otherwise. Returns
 *      `shouldReverify = consecutiveNoChangeTicks >= K AND no new dispatch`.
 *   3. {@link resolveReverifyK} — K resolution (default 2; env override
 *      `AI_SDLC_STALE_CACHE_REVERIFY_K`; explicit caller override).
 *   4. {@link classifyReverifyResult} — `new-signal` vs `same-blocker`
 *      classification so the skill body branches to AC-3 (Decision Catalog /
 *      AskUserQuestion) vs AC-4 (escalate timebox urgency).
 *
 * All GitHub I/O stays behind an injected fetcher so tests run without a
 * network. Mirrors the Runner/injection style of `reconcile.ts` /
 * `dispatch-bg-agent.ts`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ── K resolution ─────────────────────────────────────────────────────────────

/**
 * Default number of consecutive no-change ticks before the reverify gate
 * fires. K=2 gives a 2h grace window on the 1h cadence (the canonical
 * autonomous-loop cadence). See {@link CADENCE_K_GUIDANCE} for the
 * cadence→K mapping the skill body documents.
 */
export const DEFAULT_STALE_CACHE_REVERIFY_K = 2;

/** Env var an operator can set to override {@link DEFAULT_STALE_CACHE_REVERIFY_K}. */
export const STALE_CACHE_REVERIFY_K_ENV = 'AI_SDLC_STALE_CACHE_REVERIFY_K';

/**
 * Cadence→K guidance (documented in the Step 6.5 skill body). The grace
 * window before reverify is `cadence * K`, so K is tuned per cadence to
 * keep the grace window in the ~1-2h band:
 *
 *   - 1h cadence  → K=2  → 2h grace
 *   - 20m cadence → K=3  → 1h grace
 *   - 30s cadence → K=120 → 1h grace (rarely used outside soak)
 */
export const CADENCE_K_GUIDANCE: ReadonlyArray<{
  cadence: string;
  k: number;
  graceWindow: string;
}> = [
  { cadence: '1h', k: 2, graceWindow: '2h' },
  { cadence: '20m', k: 3, graceWindow: '1h' },
  { cadence: '30s', k: 120, graceWindow: '1h' },
];

/**
 * Resolve K from (in precedence order): explicit override → env var →
 * default. A non-positive or unparseable value falls through to the next
 * source so a typo never disables the gate entirely.
 */
export function resolveReverifyK(
  options: {
    override?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): number {
  const { override, env = process.env } = options;
  if (typeof override === 'number' && Number.isFinite(override) && override >= 1) {
    return Math.floor(override);
  }
  const raw = env[STALE_CACHE_REVERIFY_K_ENV];
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return DEFAULT_STALE_CACHE_REVERIFY_K;
}

// ── Blocked-PR observation + fingerprint ─────────────────────────────────────

/**
 * A single blocked PR's reverify-relevant signature. The `checkSignature`
 * is a stable string the skill body derives from `gh pr checks` output —
 * e.g. the failing check's `name + state + reason`. When it changes between
 * the cached snapshot and a fresh fetch, the blocker's *reason* changed and
 * the reverify surfaces a new actionable signal (AC-3).
 */
export interface BlockedPrSignature {
  /** PR number (string for JSON stability). */
  prNumber: string;
  /**
   * Stable fingerprint of WHY this PR is blocked — derived by the skill
   * body from the failing-check details. Same string across ticks ⇒ same
   * blocker; different string ⇒ the blocker's reason changed.
   */
  checkSignature: string;
}

/** What the Conductor observes this tick, fed to {@link updatePassiveTickState}. */
export interface PassiveTickObservation {
  /** Blocked PRs observed this tick (order-insensitive — we sort on fingerprint). */
  blockedPrs: readonly BlockedPrSignature[];
  /**
   * Number of dispatches the Conductor made this tick (bg-agent-requests
   * written / manifests claimed). A non-zero value means progress was
   * attempted, so the no-change counter resets.
   */
  dispatchCount: number;
}

/** Persisted passive-tick state (`<board-dir>/passive-state.json`). */
export interface PassiveTickState {
  schemaVersion: 'v1';
  /** Consecutive ticks with no blocked-PR fingerprint change AND no dispatch. */
  consecutiveNoChangeTicks: number;
  /** Fingerprint of the last-observed blocked-PR set (see {@link fingerprintBlockedPrs}). */
  lastBlockedFingerprint: string;
  /** Last-observed dispatch count (compared next tick). */
  lastDispatchCount: number;
  /** Per-PR signatures from the last observation, keyed by PR number — used by reverify classification. */
  lastBlockedPrs: BlockedPrSignature[];
  /** ISO-8601 timestamp of the last update (audit). */
  updatedAt: string;
}

/** The zero-state used when no `passive-state.json` exists yet. */
export function initialPassiveTickState(now: Date = new Date()): PassiveTickState {
  return {
    schemaVersion: 'v1',
    consecutiveNoChangeTicks: 0,
    lastBlockedFingerprint: '',
    lastDispatchCount: 0,
    lastBlockedPrs: [],
    updatedAt: now.toISOString(),
  };
}

/**
 * Compute an order-insensitive fingerprint of a blocked-PR set. Two
 * observations with the same PRs + same per-PR check signatures (in any
 * order) produce the same fingerprint; any change in membership OR a
 * single PR's check signature changes the fingerprint.
 */
export function fingerprintBlockedPrs(blockedPrs: readonly BlockedPrSignature[]): string {
  return blockedPrs
    .map((p) => `${p.prNumber}=${p.checkSignature}`)
    .sort()
    .join('|');
}

/** Result of {@link updatePassiveTickState}. */
export interface UpdatePassiveTickResult {
  /** The next state to persist. */
  next: PassiveTickState;
  /**
   * True when the gate should fire this tick:
   * `consecutiveNoChangeTicks >= K` AND no new dispatch happened.
   */
  shouldReverify: boolean;
  /** The K the decision was made against (echoed for logging). */
  k: number;
}

/**
 * Pure passive-tick state transition.
 *
 * - **Increment** `consecutiveNoChangeTicks` when the blocked-PR fingerprint
 *   is UNCHANGED from the prior state AND `dispatchCount === 0`. (A blocked
 *   set we've seen before, with no dispatch attempted, is the silent-rot
 *   signature.)
 * - **Reset** to 0 otherwise — either the fingerprint changed (PR state
 *   moved) OR a dispatch happened (progress attempted).
 *
 * `shouldReverify` is true iff, AFTER the increment, the counter has
 * reached K AND no dispatch happened this tick. The gate fires *exactly at*
 * K (and on every subsequent no-change tick until the operator acts), so
 * the skill body keeps escalating timebox urgency rather than going silent.
 */
export function updatePassiveTickState(
  prev: PassiveTickState,
  observation: PassiveTickObservation,
  options: { k?: number; env?: NodeJS.ProcessEnv; now?: Date } = {},
): UpdatePassiveTickResult {
  const k = resolveReverifyK({
    ...(options.k !== undefined ? { override: options.k } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  const now = options.now ?? new Date();
  const fingerprint = fingerprintBlockedPrs(observation.blockedPrs);
  const noDispatch = observation.dispatchCount === 0;
  const fingerprintUnchanged = fingerprint === prev.lastBlockedFingerprint;
  // Only a non-empty, unchanged blocked set with no dispatch counts as a
  // no-change tick. An empty blocked set (nothing blocked) must NOT
  // accumulate — there's nothing to reverify, so we reset.
  const hasBlocked = observation.blockedPrs.length > 0;
  const isNoChange = hasBlocked && fingerprintUnchanged && noDispatch;

  const consecutiveNoChangeTicks = isNoChange ? prev.consecutiveNoChangeTicks + 1 : 0;
  // `isNoChange` already implies `noDispatch` (see its definition above), so we
  // don't re-check `&& noDispatch` here — the gate fires once the no-change
  // streak reaches K.
  const shouldReverify = isNoChange && consecutiveNoChangeTicks >= k;

  const next: PassiveTickState = {
    schemaVersion: 'v1',
    consecutiveNoChangeTicks,
    lastBlockedFingerprint: fingerprint,
    lastDispatchCount: observation.dispatchCount,
    lastBlockedPrs: [...observation.blockedPrs],
    updatedAt: now.toISOString(),
  };
  return { next, shouldReverify, k };
}

// ── Reverify classification (AC-3 vs AC-4) ───────────────────────────────────

/** Classification of a reverify outcome for a single PR. */
export type ReverifyKind = 'new-signal' | 'same-blocker';

/** Result of {@link classifyReverifyResult}. */
export interface ReverifyClassification {
  kind: ReverifyKind;
  prNumber: string;
  cachedSignature: string;
  freshSignature: string;
}

/**
 * Compare a PR's cached check signature against a freshly-fetched one.
 *
 * - `new-signal` (AC-3) — the failing check changed reason since the cached
 *   snapshot. The skill body surfaces this via the Decision Catalog
 *   (`cli-decisions add`) or `AskUserQuestion` rather than heartbeating
 *   again — the situation is actionable in a NEW way.
 * - `same-blocker` (AC-4) — the failing check is identical. The skill body
 *   escalates timebox urgency in the Decision Catalog (`cli-decisions
 *   extend --timebox URGENT`) rather than silently re-sleeping.
 *
 * Signatures are compared after a trim; whitespace-only differences are not
 * treated as a new signal (they're noise from `gh` output formatting).
 */
export function classifyReverifyResult(
  cachedSignature: string,
  freshSignature: string,
  prNumber = '',
): ReverifyClassification {
  const cached = (cachedSignature ?? '').trim();
  const fresh = (freshSignature ?? '').trim();
  return {
    kind: cached === fresh ? 'same-blocker' : 'new-signal',
    prNumber,
    cachedSignature: cached,
    freshSignature: fresh,
  };
}

/**
 * Classify a batch of reverified PRs. `fresh` maps PR number → freshly
 * fetched check signature (produced by the skill body's `gh pr checks`
 * re-fetch). PRs absent from `fresh` (couldn't re-fetch) are skipped — the
 * skill body decides whether a fetch failure is itself escalation-worthy.
 */
export function classifyReverifyBatch(
  cached: readonly BlockedPrSignature[],
  fresh: Readonly<Record<string, string>>,
): ReverifyClassification[] {
  const out: ReverifyClassification[] = [];
  for (const c of cached) {
    const freshSig = fresh[c.prNumber];
    if (freshSig === undefined) continue;
    out.push(classifyReverifyResult(c.checkSignature, freshSig, c.prNumber));
  }
  return out;
}

// ── Persistence ──────────────────────────────────────────────────────────────

/** Filename of the persisted passive-tick state under the board dir. */
export const PASSIVE_STATE_FILENAME = 'passive-state.json';

/** Absolute path to the passive-state file under a board dir. */
export function passiveStatePath(boardDir: string): string {
  return path.join(boardDir, PASSIVE_STATE_FILENAME);
}

/**
 * Read the persisted passive-tick state. Returns the zero-state when the
 * file is missing OR unparseable (a corrupt file should never strand the
 * gate — we start fresh).
 */
export function readPassiveTickState(boardDir: string, now: Date = new Date()): PassiveTickState {
  const target = passiveStatePath(boardDir);
  if (!existsSync(target)) return initialPassiveTickState(now);
  try {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as Partial<PassiveTickState>;
    if (parsed === null || typeof parsed !== 'object') return initialPassiveTickState(now);
    return {
      schemaVersion: 'v1',
      consecutiveNoChangeTicks:
        typeof parsed.consecutiveNoChangeTicks === 'number' &&
        Number.isFinite(parsed.consecutiveNoChangeTicks)
          ? parsed.consecutiveNoChangeTicks
          : 0,
      lastBlockedFingerprint:
        typeof parsed.lastBlockedFingerprint === 'string' ? parsed.lastBlockedFingerprint : '',
      lastDispatchCount:
        typeof parsed.lastDispatchCount === 'number' && Number.isFinite(parsed.lastDispatchCount)
          ? parsed.lastDispatchCount
          : 0,
      lastBlockedPrs: Array.isArray(parsed.lastBlockedPrs)
        ? parsed.lastBlockedPrs.filter(
            (p): p is BlockedPrSignature =>
              p !== null &&
              typeof p === 'object' &&
              typeof (p as BlockedPrSignature).prNumber === 'string' &&
              typeof (p as BlockedPrSignature).checkSignature === 'string',
          )
        : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now.toISOString(),
    };
  } catch {
    return initialPassiveTickState(now);
  }
}

/**
 * Persist the passive-tick state atomically (temp + rename within the same
 * dir). Creates the board dir if missing.
 */
export function writePassiveTickState(boardDir: string, state: PassiveTickState): string {
  mkdirSync(boardDir, { recursive: true });
  const target = passiveStatePath(boardDir);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmp, target);
  return target;
}
