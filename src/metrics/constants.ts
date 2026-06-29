/**
 * Thresholds for behavioral-flag detection. Centralised + named so the logic is
 * auditable and tests can reference the same values. All are deterministic.
 */
export const METRICS_THRESHOLDS = {
  /** A new trade opened within this window after a loss closes = "revenge". */
  revengeWindowMs: 30 * 60 * 1000, // 30 min
  /** Minimum revenge trades to raise the flag. */
  revengeMinTrades: 2,

  /** Trades opened within this window count toward a "burst". */
  clusterWindowMs: 15 * 60 * 1000, // 15 min
  /** Minimum trades inside the cluster window to count as a burst. */
  clusterMinTrades: 3,

  /** Flag overleveraging when margin / equity exceeds this. */
  overleverageMarginRatio: 0.5,

  /** Number of most-traded symbols to surface. */
  topSymbolsCount: 5,
} as const;
