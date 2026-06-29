import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('db:supabase');

/**
 * Server-side Supabase client using the service-role key.
 *
 * This key bypasses Row Level Security — it must only ever run on the backend
 * and must never be shipped to a client. Session persistence and token
 * auto-refresh are disabled because there is no interactive user session.
 */
export const supabase: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

log.debug({ url: env.SUPABASE_URL }, 'Supabase client initialised');
