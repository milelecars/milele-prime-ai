/**
 * Audit review — read the audit_log for guardrail trips, escalations, binding
 * events, and conflicts, filterable by date and client. Used by the admin CLI
 * (`scripts/audit-review.ts`) and tested against the in-memory repo.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ExternalServiceError } from '../lib/errors.js';

export interface AuditRow {
  readonly crmClientId: string | null;
  readonly eventType: string;
  readonly detail: Record<string, unknown>;
  readonly createdAt: string; // ISO-8601
}

export type AuditCategory = 'guardrail' | 'escalation' | 'binding' | 'conflict';

/** Map review categories to concrete audit_log event types. */
export const AUDIT_CATEGORIES: Readonly<Record<AuditCategory, readonly string[]>> = {
  guardrail: ['guardrail_trip'],
  escalation: ['escalation'],
  binding: ['identity_bound', 'identity_rebind_noop'],
  conflict: [
    'identity_bind_conflict_telegram',
    'identity_bind_conflict_crm',
    'identity_bind_token_rejected',
    'identity_bind_client_missing',
  ],
};

export interface AuditFilter {
  readonly from?: string; // ISO date/time inclusive
  readonly to?: string; // ISO date/time inclusive
  readonly crmClientId?: string;
  readonly categories?: readonly AuditCategory[];
}

export interface AuditReader {
  query(filter: AuditFilter): Promise<AuditRow[]>;
}

function eventTypesFor(categories?: readonly AuditCategory[]): Set<string> | null {
  if (!categories || categories.length === 0) return null;
  const set = new Set<string>();
  for (const c of categories) for (const t of AUDIT_CATEGORIES[c]) set.add(t);
  return set;
}

/** Reads from an in-memory list (tests / repo-backed). */
export class InMemoryAuditReader implements AuditReader {
  constructor(private readonly rows: ReadonlyArray<AuditRow>) {}
  async query(filter: AuditFilter): Promise<AuditRow[]> {
    const types = eventTypesFor(filter.categories);
    return this.rows
      .filter((r) => {
        if (filter.crmClientId && r.crmClientId !== filter.crmClientId) return false;
        if (types && !types.has(r.eventType)) return false;
        if (filter.from && r.createdAt < filter.from) return false;
        if (filter.to && r.createdAt > filter.to) return false;
        return true;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/** Reads audit_log from Supabase (production). */
export class SupabaseAuditReader implements AuditReader {
  constructor(private readonly db: SupabaseClient) {}
  async query(filter: AuditFilter): Promise<AuditRow[]> {
    let q = this.db
      .from('audit_log')
      .select('crm_client_id, event_type, detail_json, created_at')
      .order('created_at', { ascending: true });
    if (filter.crmClientId) q = q.eq('crm_client_id', filter.crmClientId);
    if (filter.from) q = q.gte('created_at', filter.from);
    if (filter.to) q = q.lte('created_at', filter.to);
    const types = eventTypesFor(filter.categories);
    if (types) q = q.in('event_type', [...types]);
    const { data, error } = await q;
    if (error) throw new ExternalServiceError('Failed to query audit_log', { cause: error.message });
    return (data ?? []).map((r) => ({
      crmClientId: (r.crm_client_id as string | null) ?? null,
      eventType: r.event_type as string,
      detail: (r.detail_json as Record<string, unknown>) ?? {},
      createdAt: r.created_at as string,
    }));
  }
}

export interface AuditSummary {
  readonly total: number;
  readonly byEventType: Record<string, number>;
  readonly rows: AuditRow[];
}

/** Run a filtered audit review, returning rows + a per-event-type summary. */
export async function reviewAuditLog(reader: AuditReader, filter: AuditFilter = {}): Promise<AuditSummary> {
  const rows = await reader.query(filter);
  const byEventType: Record<string, number> = {};
  for (const r of rows) byEventType[r.eventType] = (byEventType[r.eventType] ?? 0) + 1;
  return { total: rows.length, byEventType, rows };
}
