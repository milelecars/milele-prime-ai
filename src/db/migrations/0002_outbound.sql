-- ============================================================================
-- Migration 0002 — outbound daily-report support
-- ----------------------------------------------------------------------------
-- Adds a report date + TTS character count to outbound_log, and a unique index
-- enforcing one daily_report per client per date (idempotency: never
-- double-send for a given client+date). Idempotent / safe to re-run.
-- ============================================================================

alter table outbound_log add column if not exists report_date date;
alter table outbound_log add column if not exists tts_char_count integer;

-- One daily_report row per (client, date). Partial index so non-dated rows
-- (e.g. marketing) are unaffected.
create unique index if not exists uniq_outbound_daily
  on outbound_log (crm_client_id, job_type, report_date)
  where report_date is not null;
