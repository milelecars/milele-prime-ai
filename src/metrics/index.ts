/** Deterministic metrics layer: pure math over raw connector data. */
export * from './types.js';
export { METRICS_THRESHOLDS } from './constants.js';
export { computeClientMetrics, netProfit } from './compute.js';
export { buildBehavioralObservations } from './observations.js';
export { gatherMetricsInput } from './gather.js';
export type { GatherParams, MetricsConnectors } from './gather.js';
export {
  formatCurrency,
  formatSignedCurrency,
  formatPercent,
  formatDuration,
  formatNumber,
  formatMultiplier,
} from './format.js';
