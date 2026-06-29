/** Domain types + interface for the Brokeret CRM connector. */

export type AccountTier = 'bronze' | 'silver' | 'gold' | 'platinum';
export type KycStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/** A CRM client profile. The `crmClientId` is the lookup key, not a field. */
export interface CrmClient {
  readonly name: string;
  readonly mt5Logins: readonly number[];
  readonly accountTier: AccountTier;
  readonly kycStatus: KycStatus;
  readonly timezone: string; // IANA tz, e.g. "Asia/Dubai"
  readonly country?: string; // ISO 3166-1 alpha-2, e.g. "AE"
  readonly consentAiMessaging: boolean;
  readonly consentMarketing: boolean;
}

/** Lightweight client entry returned by the paginated list endpoint. */
export interface ClientListEntry {
  readonly crmClientId: string;
  readonly name: string;
  readonly accountTier: AccountTier;
  readonly kycStatus: KycStatus;
}

/** A page of clients. `page` is 1-based. */
export interface PaginatedClients {
  readonly clients: readonly ClientListEntry[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * The Brokeret CRM API surface that all business logic depends on. Both the
 * mock and the (future) real client implement this.
 */
export interface BrokeretConnector {
  getClient(crmClientId: string): Promise<CrmClient>;
  listActiveClients(page: number, pageSize: number): Promise<PaginatedClients>;
}
