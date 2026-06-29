import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { FIXTURE_ACCOUNTS_BY_LOGIN, type Mt5AccountFixture } from '../fixtures.js';
import type { AccountSummary, ClosedTrade, MT5Connector, OpenPosition } from './types.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * In-memory MT5 connector backed by deterministic fixtures. Returns realistic,
 * varied data and copies arrays out so callers can't mutate the fixtures.
 */
export class MockMT5Connector implements MT5Connector {
  private readonly accounts: ReadonlyMap<number, Mt5AccountFixture>;

  constructor(accounts: ReadonlyMap<number, Mt5AccountFixture> = FIXTURE_ACCOUNTS_BY_LOGIN) {
    this.accounts = accounts;
  }

  private account(mt5Login: number): Mt5AccountFixture {
    const account = this.accounts.get(mt5Login);
    if (!account) {
      throw new NotFoundError(`MT5 login ${mt5Login} not found`, { mt5Login });
    }
    return account;
  }

  async getAccountSummary(mt5Login: number): Promise<AccountSummary> {
    return this.account(mt5Login).summary;
  }

  async getClosedTrades(mt5Login: number, fromDate: string, toDate: string): Promise<ClosedTrade[]> {
    if (!ISO_DATE.test(fromDate) || !ISO_DATE.test(toDate)) {
      throw new ValidationError('fromDate/toDate must be ISO calendar dates (YYYY-MM-DD)', {
        fromDate,
        toDate,
      });
    }
    if (fromDate > toDate) {
      throw new ValidationError('fromDate must not be after toDate', { fromDate, toDate });
    }
    // Inclusive filter on the trade's close date (lexicographic compare is safe
    // for ISO dates).
    return this.account(mt5Login).closedTrades.filter((t) => {
      const closeDate = t.closeTime.slice(0, 10);
      return closeDate >= fromDate && closeDate <= toDate;
    });
  }

  async getOpenPositions(mt5Login: number): Promise<OpenPosition[]> {
    return [...this.account(mt5Login).openPositions];
  }
}
