/**
 * Persistence abstraction for identity binding. Business logic depends only on
 * {@link UserRepository}; production uses the Supabase-backed implementation,
 * tests use the in-memory one.
 */
import type { Language } from '../i18n/index.js';

export interface UserRecord {
  readonly crmClientId: string;
  readonly telegramUserId: number | null;
  readonly consentAiMessaging: boolean;
  readonly boundAt: string | null; // ISO-8601
  /** Preferred chat language, or null when the user hasn't chosen one yet. */
  readonly language?: Language | null;
}

export interface BindParams {
  readonly crmClientId: string;
  readonly telegramUserId: number;
  readonly boundAt: string; // ISO-8601
}

export interface AuditEvent {
  readonly crmClientId: string | null;
  readonly eventType: string;
  readonly detail: Record<string, unknown>;
}

export interface UserRepository {
  /** Look up a user by their bound Telegram ID, or null. */
  getByTelegramId(telegramUserId: number): Promise<UserRecord | null>;
  /** Look up a user by CRM client ID, or null. */
  getByCrmId(crmClientId: string): Promise<UserRecord | null>;
  /**
   * Bind a Telegram ID to a CRM client: set telegram_user_id, bound_at, and
   * consent_ai_messaging=true. Upserts the user row. Returns the bound record.
   */
  bind(params: BindParams): Promise<UserRecord>;
  /** Set (or change) a user's preferred chat language. */
  setLanguage(crmClientId: string, language: Language): Promise<void>;
  /** Append an immutable audit-log event. */
  appendAudit(event: AuditEvent): Promise<void>;
}
