import { env } from '../../config/env.js';
import { NotImplementedError } from '../../lib/errors.js';
import type { BrokeretConnector, CrmClient, PaginatedClients } from './types.js';

/**
 * Real Brokeret CRM API client.
 *
 * STUB — awaiting the Brokeret CRM API docs. Every method throws
 * {@link NotImplementedError}. Implement against the real endpoints once docs
 * are available.
 */
export class RealBrokeretConnector implements BrokeretConnector {
  // TODO(brokeret-api): credentials are validated by config when USE_MOCK_CONNECTORS=false.
  private readonly baseUrl = env.BROKERET_API_URL ?? '';
  private readonly apiKey = env.BROKERET_API_KEY ?? '';

  // TODO(brokeret-api): construct the HTTP client + auth here.
  //   Confirm auth scheme (API key header? OAuth client-credentials?) from docs.

  async getClient(_crmClientId: string): Promise<CrmClient> {
    // TODO(brokeret-api): GET <baseUrl>/clients/{id} → map to CrmClient
    //   (incl. mt5Logins, accountTier, kycStatus, timezone, consent flags).
    throw new NotImplementedError('RealBrokeretConnector.getClient — awaiting API docs');
  }

  async listActiveClients(_page: number, _pageSize: number): Promise<PaginatedClients> {
    // TODO(brokeret-api): GET <baseUrl>/clients?status=active&page=&pageSize=
    //   → map to PaginatedClients (confirm pagination contract: page vs cursor).
    throw new NotImplementedError('RealBrokeretConnector.listActiveClients — awaiting API docs');
  }
}
