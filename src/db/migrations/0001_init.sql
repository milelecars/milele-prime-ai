-- ============================================================================
-- Migration 0001 — initial schema for milele-prime-ai
-- ----------------------------------------------------------------------------
-- Idempotent: safe to run multiple times. Apply with the Supabase SQL editor
-- or `supabase db push` / `psql "$SUPABASE_DB_URL" -f 0001_init.sql`.
-- ============================================================================
-- Note: `gen_random_uuid()` is built into Postgres core (>= 13), so no
-- extension is required. Supabase runs Postgres 15+.
-- ============================================================================

-- ── Enums ───────────────────────────────────────────────────────────────────
do $$ begin
  create type conversation_status as enum ('active', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type message_direction as enum ('in', 'out');
exception when duplicate_object then null; end $$;

do $$ begin
  create type message_content_type as enum ('text', 'voice');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outbound_job_type as enum ('daily_report', 'marketing');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outbound_status as enum ('queued', 'sent', 'failed');
exception when duplicate_object then null; end $$;

-- ── users ───────────────────────────────────────────────────────────────────
-- One row per CRM client. telegram_user_id is null until the client binds
-- their Telegram account during identity verification (Phase 3).
create table if not exists users (
  crm_client_id        text primary key,
  telegram_user_id     bigint unique,
  account_tier         text,
  timezone             text not null default 'UTC',
  consent_ai_messaging boolean not null default false,
  consent_marketing    boolean not null default false,
  bound_at             timestamptz,
  created_at           timestamptz not null default now()
);

-- ── daily_metrics ───────────────────────────────────────────────────────────
-- One precomputed metrics blob per client per day (Phase 2).
create table if not exists daily_metrics (
  crm_client_id text not null references users (crm_client_id) on delete cascade,
  date          date not null,
  metrics_json  jsonb not null default '{}'::jsonb,
  computed_at   timestamptz not null default now(),
  primary key (crm_client_id, date)
);

-- ── conversations ───────────────────────────────────────────────────────────
create table if not exists conversations (
  id                  uuid primary key default gen_random_uuid(),
  crm_client_id       text not null references users (crm_client_id) on delete cascade,
  started_at          timestamptz not null default now(),
  last_activity_at    timestamptz not null default now(),
  session_token_count integer not null default 0,
  status              conversation_status not null default 'active'
);

create index if not exists idx_conversations_client on conversations (crm_client_id);
create index if not exists idx_conversations_status on conversations (status);

-- ── messages ────────────────────────────────────────────────────────────────
create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations (id) on delete cascade,
  direction       message_direction not null,
  content_type    message_content_type not null default 'text',
  content         text not null,
  token_count     integer not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists idx_messages_conversation on messages (conversation_id, created_at);

-- ── outbound_log ────────────────────────────────────────────────────────────
create table if not exists outbound_log (
  id            uuid primary key default gen_random_uuid(),
  crm_client_id text not null references users (crm_client_id) on delete cascade,
  job_type      outbound_job_type not null,
  content_ref   text,
  voiced        boolean not null default false,
  status        outbound_status not null default 'queued',
  sent_at       timestamptz
);

create index if not exists idx_outbound_log_client on outbound_log (crm_client_id);
create index if not exists idx_outbound_log_status on outbound_log (status);

-- ── audit_log ───────────────────────────────────────────────────────────────
create table if not exists audit_log (
  id            uuid primary key default gen_random_uuid(),
  crm_client_id text references users (crm_client_id) on delete set null,
  event_type    text not null,
  detail_json   jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_audit_log_client on audit_log (crm_client_id);
create index if not exists idx_audit_log_event on audit_log (event_type, created_at);
