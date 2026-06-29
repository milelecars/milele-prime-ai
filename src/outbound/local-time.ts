/**
 * Timezone math for per-user scheduling — no external library. Uses Intl to
 * resolve IANA offsets, including DST. All functions are deterministic given
 * their inputs (the caller passes `nowMs`).
 */

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const DAY_MS = 86_400_000;

function partsInZone(timeZone: string, utcMs: number): LocalParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: LocalParts = { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    switch (p.type) {
      case 'year':
        out.year = Number(p.value);
        break;
      case 'month':
        out.month = Number(p.value);
        break;
      case 'day':
        out.day = Number(p.value);
        break;
      case 'hour':
        out.hour = Number(p.value) % 24;
        break;
      case 'minute':
        out.minute = Number(p.value);
        break;
      case 'second':
        out.second = Number(p.value);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Offset (localWallClock − UTC) in ms for the instant `utcMs` in `timeZone`. */
function offsetMs(timeZone: string, utcMs: number): number {
  const p = partsInZone(timeZone, utcMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - utcMs;
}

/** The UTC ms for a wall-clock time in `timeZone` (handles DST). */
function wallToUtc(timeZone: string, y: number, mo: number, d: number, h: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, 0, 0);
  const o1 = offsetMs(timeZone, guess);
  let utc = guess - o1;
  const o2 = offsetMs(timeZone, utc);
  if (o2 !== o1) utc = guess - o2;
  return utc;
}

/** Local calendar date in `timeZone` for an instant, as `YYYY-MM-DD`. */
export function localDateInZone(timeZone: string, utcMs: number): string {
  const p = partsInZone(timeZone, utcMs);
  const mm = String(p.month).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${p.year}-${mm}-${dd}`;
}

/**
 * The next instant (UTC ms) at which the local clock in `timeZone` reads
 * `hour:00`, strictly after `nowMs`. If today's time has already passed, the
 * next day is used.
 */
export function nextLocalHourUtc(timeZone: string, hour: number, nowMs: number): number {
  const today = partsInZone(timeZone, nowMs);
  let fire = wallToUtc(timeZone, today.year, today.month, today.day, hour);
  if (fire <= nowMs) {
    const tomorrow = partsInZone(timeZone, nowMs + DAY_MS);
    fire = wallToUtc(timeZone, tomorrow.year, tomorrow.month, tomorrow.day, hour);
  }
  return fire;
}
