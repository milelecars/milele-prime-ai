/** Types for the deterministic metrics layer. */
import type {
  AccountSummary,
  ClosedTrade,
  OpenPosition,
  TradeDirection,
} from '../connectors/mt5/types.js';

export type Granularity = 'daily' | 'weekly';

export interface MetricsWindow {
  readonly granularity: Granularity;
  readonly from: string; // YYYY-MM-DD inclusive
  readonly to: string; // YYYY-MM-DD inclusive
}

/**
 * Raw data for one window, already fetched from the connectors. The math layer
 * is pure over this — no I/O. `asOf` is the reference "now" used for
 * open-position hold calculations (kept explicit for determinism).
 */
export interface WindowData {
  readonly window: MetricsWindow;
  readonly account: AccountSummary;
  readonly closedTrades: readonly ClosedTrade[];
  readonly openPositions: readonly OpenPosition[];
  readonly asOf: string; // ISO-8601
}

export interface MetricsInput {
  readonly crmClientId: string;
  readonly current: WindowData;
  readonly prior?: WindowData;
}

export interface TradeRef {
  readonly ticket: number;
  readonly symbol: string;
  readonly direction: TradeDirection;
  readonly netProfit: number;
  readonly openTime: string;
  readonly closeTime: string;
  readonly holdMs: number;
  readonly display: { readonly netProfit: string; readonly hold: string };
}

export interface SymbolStat {
  readonly symbol: string;
  readonly trades: number;
  readonly volume: number;
  readonly netProfit: number;
}

export interface BehavioralFlags {
  readonly weekendHolding: boolean;
  readonly overleveraging: boolean;
  readonly revengeTrading: boolean;
  readonly tradeClustering: boolean;
}

export interface FlagEvidence {
  readonly weekendHeldTrades: number;
  readonly weekendLossShare: number; // 0..1 of total loss amount
  readonly marginUtilization: number; // margin / equity
  readonly revengeTrades: number;
  readonly burstTrades: number; // trades that fall inside a rapid burst
  readonly largestBurst: number; // max trades opened within the cluster window
}

export interface DrawdownStat {
  readonly maxDrawdown: number; // absolute currency, >= 0
  readonly maxDrawdownPct: number; // 0..1 relative to account balance
}

export interface OpenRiskStat {
  readonly openPositions: number;
  readonly openVolume: number;
  readonly openPnL: number;
  readonly marginUsed: number;
  readonly marginUtilization: number; // margin / equity, 0..1+
}

export interface MetricsDelta {
  readonly numTrades: number;
  readonly totalPnL: number;
  readonly winRate: number; // current - prior (in 0..1 points)
  readonly averageHoldMs: number | null;
  readonly display: {
    readonly numTrades: string;
    readonly totalPnL: string;
    readonly winRate: string;
  };
}

export interface ClientMetrics {
  readonly crmClientId: string;
  readonly window: MetricsWindow;
  readonly asOf: string;
  readonly currency: string;

  // Performance
  readonly numTrades: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakeven: number;
  readonly winRate: number; // 0..1
  readonly totalPnL: number;
  readonly grossProfit: number;
  readonly grossLoss: number; // positive magnitude
  readonly totalCosts: number; // swap + commission (signed)
  readonly bestTrade: TradeRef | null;
  readonly worstTrade: TradeRef | null;

  // Hold time
  readonly averageHoldMs: number | null;
  readonly longestHoldMs: number | null;
  readonly averageWinHoldMs: number | null;
  readonly averageLossHoldMs: number | null;

  // Symbols / exposure
  readonly mostTradedSymbols: readonly SymbolStat[];
  readonly exposureConcentration: number; // HHI 0..1 over open volume
  readonly topSymbolShare: number; // 0..1

  // Risk
  readonly drawdown: DrawdownStat;
  readonly openRisk: OpenRiskStat;

  // Week-over-week
  readonly deltas: MetricsDelta | null;

  // Behavioral
  readonly flags: BehavioralFlags;
  readonly flagEvidence: FlagEvidence;
  readonly behavioralObservations: readonly string[];

  // Preformatted strings for display
  readonly display: Readonly<Record<string, string>>;
}
