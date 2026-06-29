import { env } from '../../config/env.js';
import { NotImplementedError } from '../../lib/errors.js';
import type { AccountSummary, ClosedTrade, MT5Connector, OpenPosition } from './types.js';

/**
 * Real MT5 Manager API client.
 *
 * STUB — awaiting the MT5 Manager API docs. Every method throws
 * {@link NotImplementedError} so that selecting real connectors before the
 * integration is wired up fails loudly rather than silently returning nothing.
 *
 * When docs arrive, wire up an HTTP client here and implement each method.
 */
export class RealMT5Connector implements MT5Connector {
  // TODO(mt5-api): credentials are validated by config when USE_MOCK_CONNECTORS=false.
  private readonly baseUrl = env.MT5_API_URL ?? '';
  private readonly apiKey = env.MT5_API_KEY ?? '';

  // TODO(mt5-api): construct the HTTP client + auth here, e.g.
  //   this.http = new Http(this.baseUrl, { headers: { Authorization: `Bearer ${this.apiKey}` } });
  //   Decide on auth scheme (bearer token? signed request? session login?) once docs land.

  async getAccountSummary(_mt5Login: number): Promise<AccountSummary> {
    // TODO(mt5-api): GET <baseUrl>/account/{login}/summary → map to AccountSummary
    throw new NotImplementedError('RealMT5Connector.getAccountSummary — awaiting API docs');
  }

  async getClosedTrades(
    _mt5Login: number,
    _fromDate: string,
    _toDate: string,
  ): Promise<ClosedTrade[]> {
    // TODO(mt5-api): GET <baseUrl>/account/{login}/deals?from=&to= → map to ClosedTrade[]
    throw new NotImplementedError('RealMT5Connector.getClosedTrades — awaiting API docs');
  }

  async getOpenPositions(_mt5Login: number): Promise<OpenPosition[]> {
    // TODO(mt5-api): GET <baseUrl>/account/{login}/positions → map to OpenPosition[]
    throw new NotImplementedError('RealMT5Connector.getOpenPositions — awaiting API docs');
  }
}
