/**
 * Off-peak window evaluation per RFC §14.5. Operator-declared schedules with hour ranges
 * (possibly wrapping midnight) and optional day-of-week filters, evaluated against an
 * IANA timezone.
 */

import type { OffPeakSchedule } from './types.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Returns true when the given instant falls inside any of the schedule's windows.
 * Each window's `hours` is a range like '22-06' (which wraps midnight) or '0-7'.
 */
export function isOffPeakAt(schedule: OffPeakSchedule, when: Date): boolean {
  if (!schedule.enabled || schedule.schedule.length === 0) return false;
  for (const window of schedule.schedule) {
    if (windowMatches(window, when)) return true;
  }
  return false;
}

interface ScheduleWindow {
  tz: string;
  hours: string;
  daysOfWeek?: string;
}

function windowMatches(window: ScheduleWindow, when: Date): boolean {
  const hourMatch = window.hours.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!hourMatch) return false;
  const startHour = Number.parseInt(hourMatch[1], 10);
  const endHour = Number.parseInt(hourMatch[2], 10);

  // Get the local hour + day-of-week in the window's timezone.
  const local = getLocalTimeInTimezone(when, window.tz);
  if (!local) return false;

  // Day filter (optional).
  if (window.daysOfWeek) {
    const allowedDays = new Set(window.daysOfWeek.split(',').map((d) => d.trim()));
    if (!allowedDays.has(DAY_NAMES[local.dayOfWeek])) return false;
  }

  // Hour range; wraps midnight when start > end.
  if (startHour <= endHour) {
    return local.hour >= startHour && local.hour < endHour;
  }
  // Wrapping case: e.g., 22-06 means [22, 24) ∪ [0, 6).
  return local.hour >= startHour || local.hour < endHour;
}

interface LocalTime {
  hour: number;
  dayOfWeek: number; // 0=Sun..6=Sat
}

function getLocalTimeInTimezone(when: Date, tz: string): LocalTime | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hourCycle: 'h23',
      weekday: 'short',
    });
    const parts = fmt.formatToParts(when);
    let hour: number | null = null;
    let weekday: string | null = null;
    for (const p of parts) {
      if (p.type === 'hour') hour = Number.parseInt(p.value, 10);
      else if (p.type === 'weekday') weekday = p.value;
    }
    if (hour === null || weekday === null) return null;
    const dayIndex = DAY_NAMES.indexOf(weekday);
    if (dayIndex < 0) return null;
    return { hour, dayOfWeek: dayIndex };
  } catch {
    return null;
  }
}

/**
 * Returns the next off-peak window start strictly after `from`. Iterates by hour up to
 * a 7-day horizon — bounded scan since schedules are weekly-periodic.
 */
export function nextOffPeakStart(schedule: OffPeakSchedule, from: Date): Date | null {
  if (!schedule.enabled || schedule.schedule.length === 0) return null;
  const HORIZON_HOURS = 24 * 7;
  for (let h = 1; h <= HORIZON_HOURS; h++) {
    const candidate = new Date(from.getTime() + h * 60 * 60 * 1000);
    const candidateMinusHour = new Date(candidate.getTime() - 60 * 60 * 1000);
    // Find a transition from off → on.
    if (isOffPeakAt(schedule, candidate) && !isOffPeakAt(schedule, candidateMinusHour)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Days since `lastVerified`. Returns Infinity if the date is missing/unparseable.
 */
export function ageInDays(lastVerified: string | undefined, now: Date = new Date()): number {
  if (!lastVerified) return Infinity;
  const parsed = new Date(lastVerified);
  if (Number.isNaN(parsed.getTime())) return Infinity;
  return Math.floor((now.getTime() - parsed.getTime()) / (24 * 60 * 60 * 1000));
}

export type FreshnessLevel = 'fresh' | 'advisory' | 'error';

/**
 * Returns the freshness severity per RFC §14.5: fresh ≤ 30 days, advisory 30–90 days,
 * error > 90 days (or missing). Operators see this in cli-status --subscriptions.
 */
export function freshnessLevel(
  lastVerified: string | undefined,
  now: Date = new Date(),
): FreshnessLevel {
  const age = ageInDays(lastVerified, now);
  if (age <= 30) return 'fresh';
  if (age <= 90) return 'advisory';
  return 'error';
}
