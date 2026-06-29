/** Interfaces + deps for the outbound daily report. */
import type { BrokeretConnector, CrmClient } from '../connectors/brokeret/types.js';
import type { MT5Connector } from '../connectors/mt5/types.js';
import type { UserRepository } from '../identity/repository.js';
import type { Classifier } from '../llm/index.js';
import type { LLMClient } from '../llm/index.js';
import type { ClientMetrics, Granularity } from '../metrics/index.js';
import type { CostTracker, HaltGate } from '../ops/index.js';

// ── Persistence ──────────────────────────────────────────────────────────────
export interface DailyClaim {
  /** outbound_log row id for this client+date. */
  readonly id: string;
  /** True if a daily_report was already SENT for this client+date. */
  readonly alreadySent: boolean;
}

export interface OutboundLogUpdate {
  readonly status?: 'queued' | 'sent' | 'failed';
  readonly sentAt?: string;
  readonly voiced?: boolean;
  readonly ttsCharCount?: number;
  readonly contentRef?: string;
}

export interface MessageRecord {
  readonly crmClientId: string;
  readonly direction: 'in' | 'out';
  readonly contentType: 'text' | 'voice';
  readonly content: string;
  readonly tokenCount: number;
}

export interface MarketingClaim {
  readonly id: string;
  readonly alreadySent: boolean;
}

/** Storage the daily report + marketing depend on. */
export interface OutboundStore {
  /**
   * Atomically claim the daily_report slot for a client+date. Returns the row
   * id and whether it was already sent (idempotency guard).
   */
  claimDailyReport(crmClientId: string, reportDate: string): Promise<DailyClaim>;
  saveDailyMetrics(crmClientId: string, date: string, metrics: ClientMetrics): Promise<void>;
  updateOutboundLog(id: string, update: OutboundLogUpdate): Promise<void>;
  recordMessage(record: MessageRecord): Promise<void>;

  /** Claim the marketing slot for a campaign+client (per-campaign idempotency). */
  claimMarketing(campaignId: string, crmClientId: string): Promise<MarketingClaim>;
  /** Count marketing messages SENT to a client since `sinceMs` (weekly cap). */
  countMarketingSends(crmClientId: string, sinceMs: number): Promise<number>;
}

// ── Delivery ─────────────────────────────────────────────────────────────────
export interface OutboundAttachment {
  readonly buffer: Buffer;
  readonly filename: string;
}

export interface TelegramSender {
  sendText(chatId: number, text: string): Promise<void>;
  sendDocument(chatId: number, doc: OutboundAttachment, caption?: string): Promise<void>;
  sendPhoto(chatId: number, photo: OutboundAttachment, caption?: string): Promise<void>;
  /** Send a NATIVE voice note — `voice.buffer` must be OGG/Opus. */
  sendVoice(chatId: number, voice: OutboundAttachment, caption?: string): Promise<void>;
}

export interface TtsResult {
  readonly audio: Buffer;
  readonly format: string;
  readonly charCount: number;
}

export interface TtsClient {
  synthesize(text: string): Promise<TtsResult>;
}

/** Builds the branded PDF directly from metrics (never from the narrative). */
export type PdfBuilder = (metrics: ClientMetrics, client: CrmClient) => Promise<Buffer>;

// ── Config + deps ────────────────────────────────────────────────────────────
export interface DailyReportConfig {
  readonly voiceEnabled: boolean;
  readonly reportGranularity: Granularity;
  readonly reportHourLocal: number;
  readonly brandName: string;
}

export interface MetricsConnectors {
  readonly mt5: MT5Connector;
  readonly brokeret: BrokeretConnector;
}

export interface DailyReportDeps {
  readonly connectors: MetricsConnectors;
  readonly llm: LLMClient;
  readonly store: OutboundStore;
  readonly users: UserRepository;
  readonly telegram: TelegramSender;
  readonly tts?: TtsClient;
  readonly pdf?: PdfBuilder;
  readonly classifier?: Classifier;
  readonly halt?: HaltGate;
  readonly cost?: CostTracker;
  readonly config: DailyReportConfig;
  readonly clock: { now(): number };
}

export type DailyReportStatus =
  | 'sent'
  | 'skipped' // already sent for this date
  | 'no_consent'
  | 'unbound'
  | 'failed'
  | 'halted';

export interface DailyReportResult {
  readonly crmClientId: string;
  readonly reportDate: string;
  readonly status: DailyReportStatus;
  readonly guardrailTripped: boolean;
  readonly voiced: boolean;
  readonly ttsCharCount: number;
  readonly hasPdf: boolean;
}

// ── Scheduler ────────────────────────────────────────────────────────────────
export interface QueueLike {
  add(
    name: string,
    data: unknown,
    opts: { delay?: number; jobId?: string },
  ): Promise<unknown>;
}

export interface SchedulerDeps {
  readonly connectors: MetricsConnectors;
  readonly users: UserRepository;
  readonly queue: QueueLike;
  readonly config: DailyReportConfig;
}

export interface ScheduledReport {
  readonly crmClientId: string;
  readonly reportDate: string;
  readonly fireAtMs: number;
  readonly delayMs: number;
}

export interface DailyReportJobData {
  readonly crmClientId: string;
  readonly reportDate: string;
}
