import type { AuditEvent, BindParams, UserRecord, UserRepository } from './repository.js';

/**
 * In-memory {@link UserRepository} for tests and local runs without a database.
 * Audit events are retained on `audits` for assertions.
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly byCrmId = new Map<string, UserRecord>();
  readonly audits: Array<AuditEvent & { createdAt: string }> = [];

  /** Seed an existing user row (e.g. a pre-provisioned, not-yet-bound client). */
  seed(record: UserRecord): void {
    this.byCrmId.set(record.crmClientId, record);
  }

  async getByTelegramId(telegramUserId: number): Promise<UserRecord | null> {
    for (const record of this.byCrmId.values()) {
      if (record.telegramUserId === telegramUserId) return record;
    }
    return null;
  }

  async getByCrmId(crmClientId: string): Promise<UserRecord | null> {
    return this.byCrmId.get(crmClientId) ?? null;
  }

  async bind(params: BindParams): Promise<UserRecord> {
    const record: UserRecord = {
      crmClientId: params.crmClientId,
      telegramUserId: params.telegramUserId,
      boundAt: params.boundAt,
      consentAiMessaging: true,
    };
    this.byCrmId.set(params.crmClientId, record);
    return record;
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.audits.push({ ...event, createdAt: new Date().toISOString() });
  }
}
