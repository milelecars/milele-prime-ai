/**
 * Schedules the daily report for every active, consented, bound client at ~7am
 * in THEIR timezone, fanning out via the queue. Uses a deterministic jobId
 * (`daily:<client>:<date>`) so re-running the scheduler never double-enqueues.
 */
import { childLogger } from '../lib/logger.js';
import { localDateInZone, nextLocalHourUtc } from './local-time.js';
import type { DailyReportJobData, ScheduledReport, SchedulerDeps } from './types.js';

const log = childLogger('outbound:scheduler');
const JOB_NAME = 'daily_report';
const PAGE_SIZE = 100;

/**
 * Enqueue the next daily report for each eligible client. `nowMs` is injectable
 * for deterministic scheduling/tests.
 */
export async function scheduleDailyReports(
  deps: SchedulerDeps,
  nowMs: number = Date.now(),
): Promise<ScheduledReport[]> {
  const scheduled: ScheduledReport[] = [];

  for (let page = 1; ; page += 1) {
    const { clients, hasMore } = await deps.connectors.brokeret.listActiveClients(page, PAGE_SIZE);

    for (const entry of clients) {
      const client = await deps.connectors.brokeret.getClient(entry.crmClientId);
      if (!client.consentAiMessaging) continue;

      const bound = await deps.users.getByCrmId(entry.crmClientId);
      if (!bound || bound.telegramUserId === null) continue;

      const fireAtMs = nextLocalHourUtc(client.timezone, deps.config.reportHourLocal, nowMs);
      const reportDate = localDateInZone(client.timezone, fireAtMs);
      const data: DailyReportJobData = { crmClientId: entry.crmClientId, reportDate };

      await deps.queue.add(JOB_NAME, data, {
        delay: Math.max(0, fireAtMs - nowMs),
        jobId: `daily:${entry.crmClientId}:${reportDate}`,
      });

      scheduled.push({
        crmClientId: entry.crmClientId,
        reportDate,
        fireAtMs,
        delayMs: Math.max(0, fireAtMs - nowMs),
      });
    }

    if (!hasMore) break;
  }

  log.info({ count: scheduled.length }, 'Daily reports scheduled');
  return scheduled;
}
