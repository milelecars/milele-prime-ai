/** Deterministic display formatting helpers (rounded, with units). */

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** "$1,234.50" / "-$50.00" */
export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
  }).format(round2(amount));
}

/** Signed currency: "+$420.50" / "-$50.00" / "$0.00". */
export function formatSignedCurrency(amount: number, currency = 'USD'): string {
  const rounded = round2(amount);
  if (rounded === 0) return formatCurrency(0, currency);
  return (rounded > 0 ? '+' : '-') + formatCurrency(Math.abs(rounded), currency);
}

/** "62.5%" */
export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Percentage-point delta: "+12.5pp" / "-3.0pp". */
export function formatPoints(deltaRatio: number, digits = 1): string {
  const pts = deltaRatio * 100;
  const sign = pts > 0 ? '+' : pts < 0 ? '-' : '';
  return `${sign}${Math.abs(pts).toFixed(digits)}pp`;
}

/** Signed integer: "+3" / "-2" / "0". */
export function formatSignedInt(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** "1,234" */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

/** "3.0x" */
export function formatMultiplier(x: number): string {
  return `${x.toFixed(1)}x`;
}

/**
 * Human duration from milliseconds, two most-significant units:
 * "2d 4h", "3h 20m", "45m", "30s", "0m".
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '0m';
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86_400);
  const h = Math.floor((totalSec % 86_400) / 3_600);
  const m = Math.floor((totalSec % 3_600) / 60);
  const s = totalSec % 60;

  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0) parts.push(`${s}s`);
  if (parts.length === 0) return '0m';
  return parts.slice(0, 2).join(' ');
}
