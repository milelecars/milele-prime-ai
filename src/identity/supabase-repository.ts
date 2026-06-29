import type { SupabaseClient } from '@supabase/supabase-js';
import { ExternalServiceError } from '../lib/errors.js';
import type { AuditEvent, BindParams, UserRecord, UserRepository } from './repository.js';

interface UserRow {
  crm_client_id: string;
  telegram_user_id: number | null;
  consent_ai_messaging: boolean;
  bound_at: string | null;
}

const USER_COLUMNS = 'crm_client_id, telegram_user_id, consent_ai_messaging, bound_at';

function toRecord(row: UserRow): UserRecord {
  return {
    crmClientId: row.crm_client_id,
    telegramUserId: row.telegram_user_id,
    consentAiMessaging: row.consent_ai_messaging,
    boundAt: row.bound_at,
  };
}

/** Supabase-backed {@link UserRepository} (production). */
export class SupabaseUserRepository implements UserRepository {
  constructor(private readonly db: SupabaseClient) {}

  async getByTelegramId(telegramUserId: number): Promise<UserRecord | null> {
    const { data, error } = await this.db
      .from('users')
      .select(USER_COLUMNS)
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle<UserRow>();
    if (error) {
      throw new ExternalServiceError('Failed to look up user by Telegram ID', { cause: error.message });
    }
    return data ? toRecord(data) : null;
  }

  async getByCrmId(crmClientId: string): Promise<UserRecord | null> {
    const { data, error } = await this.db
      .from('users')
      .select(USER_COLUMNS)
      .eq('crm_client_id', crmClientId)
      .maybeSingle<UserRow>();
    if (error) {
      throw new ExternalServiceError('Failed to look up user by CRM ID', { cause: error.message });
    }
    return data ? toRecord(data) : null;
  }

  async bind(params: BindParams): Promise<UserRecord> {
    const { data, error } = await this.db
      .from('users')
      .upsert(
        {
          crm_client_id: params.crmClientId,
          telegram_user_id: params.telegramUserId,
          bound_at: params.boundAt,
          consent_ai_messaging: true,
        },
        { onConflict: 'crm_client_id' },
      )
      .select(USER_COLUMNS)
      .single<UserRow>();
    if (error || !data) {
      throw new ExternalServiceError('Failed to bind user', { cause: error?.message });
    }
    return toRecord(data);
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    const { error } = await this.db.from('audit_log').insert({
      crm_client_id: event.crmClientId,
      event_type: event.eventType,
      detail_json: event.detail,
    });
    if (error) {
      throw new ExternalServiceError('Failed to append audit event', { cause: error.message });
    }
  }
}
