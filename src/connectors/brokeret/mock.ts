import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { CLIENT_FIXTURES, FIXTURES_BY_CLIENT_ID, type ClientFixture } from '../fixtures.js';
import type {
  BrokeretConnector,
  ClientListEntry,
  CrmClient,
  PaginatedClients,
} from './types.js';

/** A client is "active" once their KYC is approved. */
function isActive(fixture: ClientFixture): boolean {
  return fixture.client.kycStatus === 'approved';
}

/**
 * In-memory Brokeret CRM connector backed by deterministic fixtures.
 */
export class MockBrokeretConnector implements BrokeretConnector {
  private readonly byId: ReadonlyMap<string, ClientFixture>;
  private readonly active: readonly ClientFixture[];

  constructor(fixtures: readonly ClientFixture[] = CLIENT_FIXTURES) {
    this.byId =
      fixtures === CLIENT_FIXTURES
        ? FIXTURES_BY_CLIENT_ID
        : new Map(fixtures.map((f) => [f.crmClientId, f]));
    // Stable order (by id) so pagination is deterministic.
    this.active = fixtures
      .filter(isActive)
      .slice()
      .sort((a, b) => a.crmClientId.localeCompare(b.crmClientId));
  }

  async getClient(crmClientId: string): Promise<CrmClient> {
    const fixture = this.byId.get(crmClientId);
    if (!fixture) {
      throw new NotFoundError(`CRM client ${crmClientId} not found`, { crmClientId });
    }
    return fixture.client;
  }

  async listActiveClients(page: number, pageSize: number): Promise<PaginatedClients> {
    if (!Number.isInteger(page) || page < 1) {
      throw new ValidationError('page must be a positive integer (1-based)', { page });
    }
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new ValidationError('pageSize must be a positive integer', { pageSize });
    }

    const total = this.active.length;
    const start = (page - 1) * pageSize;
    const slice = this.active.slice(start, start + pageSize);
    const clients: ClientListEntry[] = slice.map((f) => ({
      crmClientId: f.crmClientId,
      name: f.client.name,
      accountTier: f.client.accountTier,
      kycStatus: f.client.kycStatus,
    }));

    return {
      clients,
      page,
      pageSize,
      total,
      hasMore: start + slice.length < total,
    };
  }
}
