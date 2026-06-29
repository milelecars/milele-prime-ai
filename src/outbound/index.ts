/** Outbound daily report — text (4a), PDF (4b), and voice (4c). */
export { processDailyReport } from './dailyReport.js';
export { scheduleDailyReports } from './scheduler.js';
export { buildDailyReportPdf } from './pdf.js';
export { createElevenLabsTts } from './tts.js';
export { createTelegramSender } from './telegram.js';
export {
  createDailyReportDeps,
  createDailyReportWorker,
  dailyReportConfig,
  createMarketingDeps,
  marketingConfig,
} from './runtime.js';
export {
  selectSegment,
  scheduleCampaign,
  processMarketing,
  renderTemplate,
} from './marketing.js';
export type {
  Campaign,
  MarketingConfig,
  MarketingDeps,
  MarketingJobData,
  MarketingPayload,
  MarketingResult,
  MarketingStatus,
  Segment,
  SegmentMember,
  SegmentResult,
  ScheduledCampaign,
} from './marketing.js';
export { InMemoryOutboundStore, SupabaseOutboundStore } from './store.js';
export { localDateInZone, nextLocalHourUtc } from './local-time.js';
export type {
  DailyReportConfig,
  DailyReportDeps,
  DailyReportJobData,
  DailyReportResult,
  DailyReportStatus,
  MetricsConnectors,
  OutboundStore,
  PdfBuilder,
  QueueLike,
  ScheduledReport,
  SchedulerDeps,
  TelegramSender,
  TtsClient,
  TtsResult,
  OutboundAttachment,
} from './types.js';
