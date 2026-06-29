-- ============================================================================
-- Migration 0003 — inbound conversational sessions
-- ----------------------------------------------------------------------------
-- Extends conversations with the rolling session state the chat mentor needs:
-- exchange count, rolling summary (+ how much is summarized), guardrail-trip
-- count, escalation flag, and a post-cap cooldown. Idempotent.
-- ============================================================================

alter table conversations add column if not exists exchange_count integer not null default 0;
alter table conversations add column if not exists rolling_summary text not null default '';
alter table conversations add column if not exists summarized_count integer not null default 0;
alter table conversations add column if not exists guardrail_trips integer not null default 0;
alter table conversations add column if not exists escalated boolean not null default false;
alter table conversations add column if not exists cooldown_until timestamptz;

create index if not exists idx_conversations_client_activity
  on conversations (crm_client_id, last_activity_at desc);
