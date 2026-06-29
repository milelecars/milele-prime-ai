import type { SupabaseClient } from '@supabase/supabase-js';
import { ExternalServiceError } from '../lib/errors.js';
import type { ClientMetrics } from '../metrics/index.js';
import type {
  DailyClaim,
  MarketingClaim,
  MessageRecord,
  OutboundLogUpdate,
  OutboundStore,
} from './types.js';

const JOB_TYPE = 'daily_report';
const MARKETING = 'marketing';

// ── In-memory (tests / local without a DB) ───────────────────────────────────
interface MemLog {
  id: string;
  crmClientId: string;
  jobType: string;
  reportDate: string | null;
  status: 'queued' | 'sent' | 'failed';
  sentAt: string | null;
  voiced: boolean;
  ttsCharCount: number | null;
  contentRef: string | null;
}

export class InMemoryOutboundStore implements OutboundStore {
  readonly logs: MemLog[] = [];
  readonly dailyMetrics = new Map<string, ClientMetrics>();
  readonly messages: MessageRecord[] = [];
  private seq = 0;

  async claimDailyReport(crmClientId: string, reportDate: string): Promise<DailyClaim> {
    const existing = this.logs.find(
      (l) => l.crmClientId === crmClientId && l.reportDate === reportDate,
    );
    if (existing) {
      return { id: existing.id, alreadySent: existing.status === 'sent' };
    }
    const id = `log-${++this.seq}`;
    this.logs.push({
      id,
      crmClientId,
      jobType: JOB_TYPE,
      reportDate,
      status: 'queued',
      sentAt: null,
      voiced: false,
      ttsCharCount: null,
      contentRef: null,
    });
    return { id, alreadySent: false };
  }

  async claimMarketing(campaignId: string, crmClientId: string): Promise<MarketingClaim> {
    const existing = this.logs.find(
      (l) => l.jobType === MARKETING && l.crmClientId === crmClientId && l.contentRef === campaignId,
    );
    if (existing) return { id: existing.id, alreadySent: existing.status === 'sent' };
    const id = `log-${++this.seq}`;
    this.logs.push({
      id,
      crmClientId,
      jobType: MARKETING,
      reportDate: null,
      status: 'queued',
      sentAt: null,
      voiced: false,
      ttsCharCount: null,
      contentRef: campaignId,
    });
    return { id, alreadySent: false };
  }

  async countMarketingSends(crmClientId: string, sinceMs: number): Promise<number> {
    return this.logs.filter(
      (l) =>
        l.jobType === MARKETING &&
        l.crmClientId === crmClientId &&
        l.status === 'sent' &&
        l.sentAt !== null &&
        Date.parse(l.sentAt) >= sinceMs,
    ).length;
  }

  async saveDailyMetrics(crmClientId: string, date: string, metrics: ClientMetrics): Promise<void> {
    this.dailyMetrics.set(`${crmClientId}:${date}`, metrics);
  }

  async updateOutboundLog(id: string, update: OutboundLogUpdate): Promise<void> {
    const log = this.logs.find((l) => l.id === id);
    if (!log) return;
    if (update.status !== undefined) log.status = update.status;
    if (update.sentAt !== undefined) log.sentAt = update.sentAt;
    if (update.voiced !== undefined) log.voiced = update.voiced;
    if (update.ttsCharCount !== undefined) log.ttsCharCount = update.ttsCharCount;
    if (update.contentRef !== undefined) log.contentRef = update.contentRef;
  }

  async recordMessage(record: MessageRecord): Promise<void> {
    this.messages.push(record);
  }
}

// ── Supabase (production) ────────────────────────────────────────────────────
export class SupabaseOutboundStore implements OutboundStore {
  constructor(private readonly db: SupabaseClient) {}

  async claimDailyReport(crmClientId: string, reportDate: string): Promise<DailyClaim> {
    // Look for an existing row for this client+date first.
    const existing = await this.db
      .from('outbound_log')
      .select('id, status')
      .eq('crm_client_id', crmClientId)
      .eq('job_type', JOB_TYPE)
      .eq('report_date', reportDate)
      .maybeSingle<{ id: string; status: string }>();
    if (existing.error) {
      throw new ExternalServiceError('Failed to read outbound_log', { cause: existing.error.message });
    }
    if (existing.data) {
      return { id: existing.data.id, alreadySent: existing.data.status === 'sent' };
    }

    // Insert a fresh claim. The unique index makes this safe under races: a
    // concurrent insert loses with a unique violation, and we re-read.
    const inserted = await this.db
      .from('outbound_log')
      .insert({ crm_client_id: crmClientId, job_type: JOB_TYPE, report_date: reportDate, status: 'queued' })
      .select('id')
      .single<{ id: string }>();
    if (inserted.error || !inserted.data) {
      const reread = await this.db
        .from('outbound_log')
        .select('id, status')
        .eq('crm_client_id', crmClientId)
        .eq('job_type', JOB_TYPE)
        .eq('report_date', reportDate)
        .maybeSingle<{ id: string; status: string }>();
      if (reread.data) return { id: reread.data.id, alreadySent: reread.data.status === 'sent' };
      throw new ExternalServiceError('Failed to claim daily report', {
        cause: inserted.error?.message,
      });
    }
    return { id: inserted.data.id, alreadySent: false };
  }

  async claimMarketing(campaignId: string, crmClientId: string): Promise<MarketingClaim> {
    const existing = await this.db
      .from('outbound_log')
      .select('id, status')
      .eq('crm_client_id', crmClientId)
      .eq('job_type', MARKETING)
      .eq('content_ref', campaignId)
      .maybeSingle<{ id: string; status: string }>();
    if (existing.error) {
      throw new ExternalServiceError('Failed to read marketing log', { cause: existing.error.message });
    }
    if (existing.data) return { id: existing.data.id, alreadySent: existing.data.status === 'sent' };

    const inserted = await this.db
      .from('outbound_log')
      .insert({ crm_client_id: crmClientId, job_type: MARKETING, content_ref: campaignId, status: 'queued' })
      .select('id')
      .single<{ id: string }>();
    if (inserted.error || !inserted.data) {
      throw new ExternalServiceError('Failed to claim marketing slot', { cause: inserted.error?.message });
    }
    return { id: inserted.data.id, alreadySent: false };
  }

  async countMarketingSends(crmClientId: string, sinceMs: number): Promise<number> {
    const { count, error } = await this.db
      .from('outbound_log')
      .select('id', { count: 'exact', head: true })
      .eq('crm_client_id', crmClientId)
      .eq('job_type', MARKETING)
      .eq('status', 'sent')
      .gte('sent_at', new Date(sinceMs).toISOString());
    if (error) throw new ExternalServiceError('Failed to count marketing sends', { cause: error.message });
    return count ?? 0;
  }

  async saveDailyMetrics(crmClientId: string, date: string, metrics: ClientMetrics): Promise<void> {
    const { error } = await this.db
      .from('daily_metrics')
      .upsert(
        { crm_client_id: crmClientId, date, metrics_json: metrics, computed_at: new Date().toISOString() },
        { onConflict: 'crm_client_id,date' },
      );
    if (error) throw new ExternalServiceError('Failed to save daily_metrics', { cause: error.message });
  }

  async updateOutboundLog(id: string, update: OutboundLogUpdate): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (update.status !== undefined) patch['status'] = update.status;
    if (update.sentAt !== undefined) patch['sent_at'] = update.sentAt;
    if (update.voiced !== undefined) patch['voiced'] = update.voiced;
    if (update.ttsCharCount !== undefined) patch['tts_char_count'] = update.ttsCharCount;
    if (update.contentRef !== undefined) patch['content_ref'] = update.contentRef;
    const { error } = await this.db.from('outbound_log').update(patch).eq('id', id);
    if (error) throw new ExternalServiceError('Failed to update outbound_log', { cause: error.message });
  }

  async recordMessage(record: MessageRecord): Promise<void> {
    const conversationId = await this.getOrCreateConversation(record.crmClientId);
    const { error } = await this.db.from('messages').insert({
      conversation_id: conversationId,
      direction: record.direction,
      content_type: record.contentType,
      content: record.content,
      token_count: record.tokenCount,
    });
    if (error) throw new ExternalServiceError('Failed to record message', { cause: error.message });
  }

  private async getOrCreateConversation(crmClientId: string): Promise<string> {
    const found = await this.db
      .from('conversations')
      .select('id')
      .eq('crm_client_id', crmClientId)
      .eq('status', 'active')
      .order('last_activity_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (found.error) {
      throw new ExternalServiceError('Failed to read conversations', { cause: found.error.message });
    }
    if (found.data) return found.data.id;

    const created = await this.db
      .from('conversations')
      .insert({ crm_client_id: crmClientId, status: 'active' })
      .select('id')
      .single<{ id: string }>();
    if (created.error || !created.data) {
      throw new ExternalServiceError('Failed to create conversation', { cause: created.error?.message });
    }
    return created.data.id;
  }
}
