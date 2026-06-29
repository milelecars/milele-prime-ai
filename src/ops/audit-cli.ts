/**
 * Admin CLI: review audit_log (guardrail trips, escalations, binding events,
 * conflicts), filterable by date and client.
 *
 *   tsx src/ops/audit-cli.ts --category guardrail,escalation --client crm-1001 \
 *     --from 2026-06-01 --to 2026-06-30
 */
import { pathToFileURL } from 'node:url';
import { supabase } from '../db/supabase.js';
import { reviewAuditLog, SupabaseAuditReader, type AuditCategory, type AuditFilter } from './index.js';

const CATEGORIES: ReadonlySet<string> = new Set(['guardrail', 'escalation', 'binding', 'conflict']);

function parseArgs(argv: readonly string[]): AuditFilter {
  const filter: { from?: string; to?: string; crmClientId?: string; categories?: AuditCategory[] } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--from' && next) (filter.from = next), (i += 1);
    else if (arg === '--to' && next) (filter.to = next), (i += 1);
    else if (arg === '--client' && next) (filter.crmClientId = next), (i += 1);
    else if (arg === '--category' && next) {
      filter.categories = next.split(',').filter((c): c is AuditCategory => CATEGORIES.has(c));
      i += 1;
    }
  }
  return filter;
}

export async function runAuditCli(argv: readonly string[]): Promise<void> {
  const filter = parseArgs(argv);
  const summary = await reviewAuditLog(new SupabaseAuditReader(supabase), filter);
  // eslint-disable-next-line no-console
  console.log(`Audit review — ${summary.total} event(s)`, filter);
  // eslint-disable-next-line no-console
  console.table(summary.byEventType);
  for (const row of summary.rows) {
    // eslint-disable-next-line no-console
    console.log(`${row.createdAt}  ${row.eventType}  ${row.crmClientId ?? '-'}  ${JSON.stringify(row.detail)}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runAuditCli(process.argv.slice(2)).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
