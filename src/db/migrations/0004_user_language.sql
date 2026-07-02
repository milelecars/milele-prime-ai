-- ============================================================================
-- Migration 0004 — per-user chat language preference
-- ----------------------------------------------------------------------------
-- Adds the language the conversational mentor (and the deterministic strings)
-- use when talking to a client. NULL means "not yet chosen" — the app treats
-- that as the default language (English). The value is a supported primary
-- language subtag: en | ur | hi | ar | fr | es | pt. Idempotent.
-- ============================================================================

alter table users add column if not exists language text;
