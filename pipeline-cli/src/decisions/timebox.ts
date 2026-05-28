/**
 * RFC-0035 Decision Catalog — timebox parsing + expiry math (AISDLC-447).
 *
 * Decisions carry an optional `timebox` so urgency escalates predictably.
 * Operators pass either an ISO-8601 duration (`PT4H`, `P1D`, `P7D`, ...) or
 * a categorical alias (`URGENT`/`24H`/`WEEK`/`BACKLOG`) that maps to a
 * canonical duration.
 *
 * The 18h passive heartbeat on 2026-05-26/27 motivated this: operator
 * decisions had no urgency-escalation mechanism, so a sub-day-blocking
 * decision sat unanswered overnight. With `--timebox PT4H` it would have
 * surfaced as expired the morning after.
 *
 * Scope: parsing + arithmetic only. The CLI surface (`cli-decisions add
 * --timebox`, `list --expired`, `extend`) lives in `cli/decisions.ts`; the
 * event model + projection live in `decision-record.ts` / `projection.ts`.
 *
 * @module decisions/timebox
 */

// ── Categorical aliases ──────────────────────────────────────────────────────

/**
 * Categorical timebox aliases — operator-friendly shortcuts that map to
 * canonical ISO-8601 durations. The exact aliases were chosen for the
 * autonomous-loop friction patterns documented on 2026-05-25..27:
 *
 *   URGENT   → PT4H  (must be answered within a half-workday)
 *   24H      → P1D   (next-day-blocking; ships after one operator sleep cycle)
 *   WEEK     → P7D   (default urgency for routine framework decisions)
 *   BACKLOG  → P30D  (low-urgency; bucket for "decide eventually")
 */
export const TIMEBOX_CATEGORICAL_ALIASES = {
  URGENT: 'PT4H',
  '24H': 'P1D',
  WEEK: 'P7D',
  BACKLOG: 'P30D',
} as const satisfies Record<string, string>;

export type TimeboxAlias = keyof typeof TIMEBOX_CATEGORICAL_ALIASES;

const ALIAS_KEYS: readonly string[] = Object.keys(TIMEBOX_CATEGORICAL_ALIASES);

// ── ISO-8601 duration parser ─────────────────────────────────────────────────

/**
 * Strict subset of ISO-8601 durations the catalog supports:
 *   - Date-only:     P[nY][nM][nD]
 *   - Time-only:     PT[nH][nM][nS]
 *   - Date + time:   P[nY][nM][nD]T[nH][nM][nS]
 *
 * At least one designator must be present. Weeks form (`PnW`) is also
 * accepted because it's the most idiomatic way to write `P7D` / `P14D`.
 *
 * We do NOT accept negative durations, fractional designators, or the
 * `±YYYY-MM-DDThh:mm:ss/PnYnMnDTnHnMnS` interval form — those are out of
 * scope for a backlog-task timebox and would only invite surprise.
 */
const ISO_DURATION_RE =
  /^P(?:(\d+)W|(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/;

/**
 * Days-per-month + days-per-year used to convert calendar-month / calendar-
 * year durations to wall-clock milliseconds. We use averages (30 / 365.25)
 * rather than the calling clock's actual calendar because the catalog needs
 * a deterministic answer at projection time: a decision opened on the 31st
 * with `P1M` should expire at the same instant regardless of which month
 * boundary actually lands first.
 *
 * Most timeboxes are PT4H / P1D / P7D where this doesn't matter; the
 * averaging is the well-defined fallback for the long-tail (`P1M`, `P1Y`).
 */
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;
const MS_PER_MONTH_AVG = 30 * MS_PER_DAY;
const MS_PER_YEAR_AVG = Math.round(365.25 * MS_PER_DAY);

/**
 * Parse an ISO-8601 duration string into milliseconds. Returns null on
 * invalid input.
 */
export function parseIsoDurationToMs(input: string): number | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = ISO_DURATION_RE.exec(trimmed);
  if (!m) return null;
  const [, weeks, years, months, days, hours, mins, secs] = m;
  // The regex permits "P" with no designators — reject that explicitly.
  if (!weeks && !years && !months && !days && !hours && !mins && !secs) return null;

  let ms = 0;
  if (weeks) ms += Number.parseInt(weeks, 10) * MS_PER_WEEK;
  if (years) ms += Number.parseInt(years, 10) * MS_PER_YEAR_AVG;
  if (months) ms += Number.parseInt(months, 10) * MS_PER_MONTH_AVG;
  if (days) ms += Number.parseInt(days, 10) * MS_PER_DAY;
  if (hours) ms += Number.parseInt(hours, 10) * MS_PER_HOUR;
  if (mins) ms += Number.parseInt(mins, 10) * MS_PER_MINUTE;
  if (secs) ms += Number.parseInt(secs, 10) * MS_PER_SECOND;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms;
}

// ── Public parse + normalize ─────────────────────────────────────────────────

export interface ParsedTimebox {
  /** The canonical ISO-8601 duration string (categorical aliases are resolved). */
  duration: string;
  /** Milliseconds equivalent — useful for sorting / urgency math. */
  durationMs: number;
  /**
   * True when the operator passed a categorical alias (URGENT/24H/WEEK/BACKLOG)
   * — useful for the CLI to surface the canonical duration back in confirm
   * messages without losing the operator's intent.
   */
  alias?: TimeboxAlias;
}

/**
 * Parse a raw `--timebox <input>` string into a canonical duration.
 *
 * Accepts:
 *   - ISO-8601 durations (`PT4H`, `P1D`, `P7D`, `P1Y`, ...).
 *   - Categorical aliases (case-insensitive): `URGENT`, `24H`, `WEEK`, `BACKLOG`.
 *
 * Throws on invalid input — the catalog refuses to persist a decision with
 * a malformed timebox because every downstream consumer (sort, filter,
 * countdown) assumes the field is well-formed.
 */
export function parseTimebox(input: string): ParsedTimebox {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(
      `[decisions] --timebox: empty value; expected ISO-8601 duration (e.g. PT4H, P1D, P7D) or alias (${ALIAS_KEYS.join('|')})`,
    );
  }
  const raw = input.trim();
  // Try categorical-alias lookup first (case-insensitive).
  const upper = raw.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(TIMEBOX_CATEGORICAL_ALIASES, upper)) {
    const alias = upper as TimeboxAlias;
    const duration = TIMEBOX_CATEGORICAL_ALIASES[alias];
    const ms = parseIsoDurationToMs(duration);
    if (ms === null) {
      // Should never happen — the alias table is hard-coded — but type-narrow.
      throw new Error(`[decisions] --timebox: internal alias table broken for ${alias}`);
    }
    return { duration, durationMs: ms, alias };
  }
  // Fall back to literal ISO-8601 parsing.
  const ms = parseIsoDurationToMs(raw);
  if (ms === null) {
    throw new Error(
      `[decisions] --timebox: invalid value "${input}"; expected ISO-8601 duration (e.g. PT4H, P1D, P7D) or alias (${ALIAS_KEYS.join('|')})`,
    );
  }
  return { duration: raw, durationMs: ms };
}

// ── Expiry math ──────────────────────────────────────────────────────────────

/**
 * Compute the absolute expiry timestamp for a timebox opened at `openedAt`.
 * Returns an ISO-8601 UTC string suitable for the `decision-opened` event's
 * `timeboxExpiresAt` field.
 */
export function computeTimeboxExpiresAt(durationMs: number, openedAt: Date = new Date()): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(
      `[decisions] computeTimeboxExpiresAt: durationMs must be positive (got ${durationMs})`,
    );
  }
  return new Date(openedAt.getTime() + durationMs).toISOString();
}

/**
 * Milliseconds remaining until expiry — negative when already expired.
 * Returns null when `expiresAtIso` is missing or unparseable (treated as
 * "no timebox" by sort / filter callers).
 */
export function msRemainingUntil(
  expiresAtIso: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!expiresAtIso) return null;
  const t = Date.parse(expiresAtIso);
  if (!Number.isFinite(t)) return null;
  return t - now.getTime();
}

/**
 * True when the timebox is in the past relative to `now`. False when the
 * field is missing (decisions without a timebox can never be "expired").
 */
export function isTimeboxExpired(
  expiresAtIso: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const ms = msRemainingUntil(expiresAtIso, now);
  if (ms === null) return false;
  return ms < 0;
}
