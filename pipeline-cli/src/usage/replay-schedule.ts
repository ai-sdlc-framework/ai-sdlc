/**
 * Off-peak window check for replay (`--off-peak`).
 *
 * A small, self-contained equivalent of the orchestrator's off-peak schedule
 * (operator-declared hour ranges, possibly wrapping midnight, with an optional
 * day filter, evaluated in an IANA timezone). It is kept here because
 * pipeline-cli does not depend on the orchestrator package.
 *
 * A window is written `TZ@HH-HH` or `TZ@HH-HH@Day,Day`, for example
 * `America/Los_Angeles@22-06` or `UTC@0-24@Sat,Sun`.
 *
 * @module usage/replay-schedule
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface OffPeakWindow {
  tz: string;
  startHour: number;
  endHour: number;
  days?: ReadonlySet<string>;
}

/** Parse one window, or return an error message. */
export function parseOffPeakWindow(text: string): OffPeakWindow | string {
  const parts = text.split('@');
  if (parts.length < 2 || parts.length > 3) {
    return `Invalid off-peak window "${text}"; use TZ@HH-HH or TZ@HH-HH@Day,Day.`;
  }
  const [tz, hours, days] = parts as [string, string, string | undefined];
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(hours);
  if (!m) return `Invalid off-peak hours "${hours}"; use HH-HH, for example 22-06.`;
  const startHour = Number(m[1]);
  const endHour = Number(m[2]);
  if (startHour > 24 || endHour > 24 || startHour === endHour) {
    return `Invalid off-peak hours "${hours}"; hours run 0 to 24 and the range must not be empty.`;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return `Unknown timezone "${tz}" in off-peak window "${text}".`;
  }
  let daySet: Set<string> | undefined;
  if (days !== undefined) {
    daySet = new Set(days.split(',').map((d) => d.trim()));
    for (const d of daySet) {
      if (!DAY_NAMES.includes(d))
        return `Unknown day "${d}"; use Sun, Mon, Tue, Wed, Thu, Fri, Sat.`;
    }
  }
  return { tz, startHour, endHour, ...(daySet ? { days: daySet } : {}) };
}

function localTime(when: Date, tz: string): { hour: number; day: string } | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hourCycle: 'h23',
      weekday: 'short',
    }).formatToParts(when);
    const hour = parts.find((p) => p.type === 'hour')?.value;
    const day = parts.find((p) => p.type === 'weekday')?.value;
    if (hour === undefined || day === undefined) return undefined;
    return { hour: Number.parseInt(hour, 10), day };
  } catch {
    return undefined;
  }
}

function inWindow(w: OffPeakWindow, when: Date): boolean {
  const local = localTime(when, w.tz);
  if (!local) return false;
  if (w.days && !w.days.has(local.day)) return false;
  return w.startHour < w.endHour
    ? local.hour >= w.startHour && local.hour < w.endHour
    : local.hour >= w.startHour || local.hour < w.endHour;
}

export function isOffPeakNow(windows: readonly OffPeakWindow[], when: Date): boolean {
  return windows.some((w) => inWindow(w, when));
}

/** Start of the next off-peak period strictly after `from`, scanning one week by the hour. */
export function nextOffPeakStart(windows: readonly OffPeakWindow[], from: Date): Date | undefined {
  const HOUR = 3_600_000;
  for (let h = 1; h <= 24 * 7; h++) {
    const at = new Date(from.getTime() + h * HOUR);
    if (isOffPeakNow(windows, at) && !isOffPeakNow(windows, new Date(at.getTime() - HOUR))) {
      return at;
    }
  }
  return undefined;
}
