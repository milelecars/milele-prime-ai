/** Domain types + interface for the MT5 Manager connector. */

export type TradeDirection = 'buy' | 'sell';

/** Live account snapshot. `openPnL` is the floating P/L of open positions. */
export interface AccountSummary {
  readonly login: number;
  readonly balance: number;
  readonly equity: number;
  readonly margin: number;
  readonly openPnL: number;
  readonly currency: string;
}

/** A single closed deal/trade. */
export interface ClosedTrade {
  readonly ticket: number;
  readonly symbol: string;
  readonly direction: TradeDirection;
  readonly volume: number;
  readonly openTime: string; // ISO-8601
  readonly closeTime: string; // ISO-8601
  readonly openPrice: number;
  readonly closePrice: number;
  readonly profit: number;
  readonly swap: number;
  readonly commission: number;
}

/** A currently-open position. */
export interface OpenPosition {
  readonly ticket: number;
  readonly symbol: string;
  readonly direction: TradeDirection;
  readonly volume: number;
  readonly openTime: string; // ISO-8601
  readonly openPrice: number;
  readonly currentPrice: number;
  readonly unrealizedPnL: number;
  readonly swap: number;
}

/**
 * The MT5 Manager API surface that all business logic depends on. Both the
 * mock and the (future) real client implement this — callers never reference
 * a concrete class.
 *
 * `fromDate`/`toDate` are inclusive ISO calendar dates (`YYYY-MM-DD`).
 */
export interface MT5Connector {
  getAccountSummary(mt5Login: number): Promise<AccountSummary>;
  getClosedTrades(mt5Login: number, fromDate: string, toDate: string): Promise<ClosedTrade[]>;
  getOpenPositions(mt5Login: number): Promise<OpenPosition[]>;
}
