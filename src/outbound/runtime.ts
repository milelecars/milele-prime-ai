/**
 * Production wiring for the daily report: builds the real dependency bundle
 * (Claude, Supabase, grammY, ElevenLabs, pdfmake) and the BullMQ worker.
 *
 * Kept separate from the core logic so the core stays testable against fakes.
 */
import { Worker, type Job } from 'bullmq';
import { brokeret, mt5 } from '../config/connectors.js';
import { env } from '../config/env.js';
import { userRepository } from '../identity/index.js';
import { createLLMClient } from '../llm/index.js';
import { createCostTracker, haltGate } from '../ops/wiring.js';
import { supabase } from '../db/supabase.js';
import { redisConnection } from '../queue/connection.js';
import { QUEUE_NAMES } from '../queue/names.js';
import { processDailyReport } from './dailyReport.js';
import { processMarketing, type MarketingConfig, type MarketingDeps, type MarketingJobData } from './marketing.js';
import { buildDailyReportPdf } from './pdf.js';
import { SupabaseOutboundStore } from './store.js';
import { createTelegramSender } from './telegram.js';
import { createElevenLabsTts } from './tts.js';
import type { DailyReportConfig, DailyReportDeps, DailyReportJobData } from './types.js';

export function dailyReportConfig(): DailyReportConfig {
  return {
    voiceEnabled: env.DAILY_VOICE_ENABLED,
    reportGranularity: env.DAILY_REPORT_GRANULARITY,
    reportHourLocal: env.DAILY_REPORT_HOUR,
    brandName: 'Milele Prime',
  };
}

/** Build the full production deps bundle. */
export function createDailyReportDeps(): DailyReportDeps {
  const llm = createLLMClient();
  return {
    connectors: { mt5, brokeret },
    llm,
    store: new SupabaseOutboundStore(supabase),
    users: userRepository,
    telegram: createTelegramSender(),
    tts: createElevenLabsTts(),
    pdf: buildDailyReportPdf,
    classifier: (text: string) => llm.classifyOutbound(text),
    halt: haltGate(),
    cost: createCostTracker(),
    config: dailyReportConfig(),
    clock: { now: () => Date.now() },
  };
}

export function marketingConfig(): MarketingConfig {
  return { hourLocal: env.MARKETING_HOUR_LOCAL, weeklyCap: env.MARKETING_WEEKLY_CAP };
}

/** Marketing deps for the worker (no queue — workers don't enqueue). */
export function createMarketingDeps(): MarketingDeps {
  return {
    brokeret,
    users: userRepository,
    telegram: createTelegramSender(),
    store: new SupabaseOutboundStore(supabase),
    config: marketingConfig(),
    clock: { now: () => Date.now() },
    halt: haltGate(),
  };
}

/** Create the BullMQ worker that processes daily-report AND marketing jobs. */
export function createDailyReportWorker(deps: DailyReportDeps = createDailyReportDeps()): Worker {
  const marketingDeps = createMarketingDeps();
  return new Worker(
    QUEUE_NAMES.OUTBOUND,
    async (job: Job) => {
      if (job.name === 'daily_report') return processDailyReport(deps, job.data as DailyReportJobData);
      if (job.name === 'marketing') return processMarketing(marketingDeps, job.data as MarketingJobData);
      return undefined;
    },
    { connection: redisConnection },
  );
}
