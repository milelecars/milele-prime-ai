import type { SupabaseClient } from '@supabase/supabase-js';
import { ExternalServiceError } from '../lib/errors.js';
import type { InboundStore, SessionState, StoredMessage } from './types.js';

// ── In-memory (tests / local) ────────────────────────────────────────────────
export class InMemoryInboundStore implements InboundStore {
  private readonly sessions: SessionState[] = [];
  private readonly messages = new Map<string, StoredMessage[]>();
  private seq = 0;

  async getLatestSession(crmClientId: string): Promise<SessionState | null> {
    const matching = this.sessions.filter((s) => s.crmClientId === crmClientId);
    const latest = matching[matching.length - 1];
    return latest ? { ...latest } : null;
  }

  async openSession(crmClientId: string, nowMs: number): Promise<SessionState> {
    const state: SessionState = {
      conversationId: `conv-${++this.seq}`,
      crmClientId,
      status: 'active',
      startedAt: nowMs,
      lastActivityAt: nowMs,
      tokenCount: 0,
      exchangeCount: 0,
      rollingSummary: '',
      summarizedCount: 0,
      guardrailTrips: 0,
      escalated: false,
      cooldownUntil: null,
    };
    this.sessions.push(state);
    this.messages.set(state.conversationId, []);
    return { ...state };
  }

  async updateSession(state: SessionState): Promise<void> {
    const idx = this.sessions.findIndex((s) => s.conversationId === state.conversationId);
    if (idx >= 0) this.sessions[idx] = { ...state };
  }

  async recordMessage(conversationId: string, message: StoredMessage): Promise<void> {
    const list = this.messages.get(conversationId) ?? [];
    list.push(message);
    this.messages.set(conversationId, list);
  }

  async recentMessages(conversationId: string, limit: number): Promise<StoredMessage[]> {
    const list = this.messages.get(conversationId) ?? [];
    return list.slice(Math.max(0, list.length - limit));
  }

  async allMessages(conversationId: string): Promise<StoredMessage[]> {
    return [...(this.messages.get(conversationId) ?? [])];
  }
}

// ── Supabase (production) ────────────────────────────────────────────────────
interface ConvRow {
  id: string;
  crm_client_id: string;
  status: string;
  started_at: string;
  last_activity_at: string;
  session_token_count: number;
  exchange_count: number;
  rolling_summary: string;
  summarized_count: number;
  guardrail_trips: number;
  escalated: boolean;
  cooldown_until: string | null;
}

const CONV_COLUMNS =
  'id, crm_client_id, status, started_at, last_activity_at, session_token_count, exchange_count, rolling_summary, summarized_count, guardrail_trips, escalated, cooldown_until';

function toState(row: ConvRow): SessionState {
  return {
    conversationId: row.id,
    crmClientId: row.crm_client_id,
    status: row.status === 'closed' ? 'closed' : 'active',
    startedAt: Date.parse(row.started_at),
    lastActivityAt: Date.parse(row.last_activity_at),
    tokenCount: row.session_token_count,
    exchangeCount: row.exchange_count,
    rollingSummary: row.rolling_summary,
    summarizedCount: row.summarized_count,
    guardrailTrips: row.guardrail_trips,
    escalated: row.escalated,
    cooldownUntil: row.cooldown_until ? Date.parse(row.cooldown_until) : null,
  };
}

export class SupabaseInboundStore implements InboundStore {
  constructor(private readonly db: SupabaseClient) {}

  async getLatestSession(crmClientId: string): Promise<SessionState | null> {
    const { data, error } = await this.db
      .from('conversations')
      .select(CONV_COLUMNS)
      .eq('crm_client_id', crmClientId)
      .order('last_activity_at', { ascending: false })
      .limit(1)
      .maybeSingle<ConvRow>();
    if (error) throw new ExternalServiceError('Failed to load session', { cause: error.message });
    return data ? toState(data) : null;
  }

  async openSession(crmClientId: string, nowMs: number): Promise<SessionState> {
    const ts = new Date(nowMs).toISOString();
    const { data, error } = await this.db
      .from('conversations')
      .insert({ crm_client_id: crmClientId, status: 'active', started_at: ts, last_activity_at: ts })
      .select(CONV_COLUMNS)
      .single<ConvRow>();
    if (error || !data) throw new ExternalServiceError('Failed to open session', { cause: error?.message });
    return toState(data);
  }

  async updateSession(state: SessionState): Promise<void> {
    const { error } = await this.db
      .from('conversations')
      .update({
        status: state.status,
        last_activity_at: new Date(state.lastActivityAt).toISOString(),
        session_token_count: state.tokenCount,
        exchange_count: state.exchangeCount,
        rolling_summary: state.rollingSummary,
        summarized_count: state.summarizedCount,
        guardrail_trips: state.guardrailTrips,
        escalated: state.escalated,
        cooldown_until: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : null,
      })
      .eq('id', state.conversationId);
    if (error) throw new ExternalServiceError('Failed to update session', { cause: error.message });
  }

  async recordMessage(conversationId: string, message: StoredMessage): Promise<void> {
    const { error } = await this.db.from('messages').insert({
      conversation_id: conversationId,
      direction: message.direction,
      content_type: message.contentType,
      content: message.content,
      token_count: message.tokenCount,
    });
    if (error) throw new ExternalServiceError('Failed to record message', { cause: error.message });
  }

  async recentMessages(conversationId: string, limit: number): Promise<StoredMessage[]> {
    const { data, error } = await this.db
      .from('messages')
      .select('direction, content_type, content, token_count')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new ExternalServiceError('Failed to read messages', { cause: error.message });
    return (data ?? [])
      .reverse()
      .map((r) => ({
        direction: r.direction as 'in' | 'out',
        contentType: r.content_type as 'text' | 'voice',
        content: r.content as string,
        tokenCount: r.token_count as number,
      }));
  }

  async allMessages(conversationId: string): Promise<StoredMessage[]> {
    const { data, error } = await this.db
      .from('messages')
      .select('direction, content_type, content, token_count')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });
    if (error) throw new ExternalServiceError('Failed to read messages', { cause: error.message });
    return (data ?? []).map((r) => ({
      direction: r.direction as 'in' | 'out',
      contentType: r.content_type as 'text' | 'voice',
      content: r.content as string,
      tokenCount: r.token_count as number,
    }));
  }
}
