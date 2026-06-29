/** Interfaces + deps for the inbound conversational mentor. */
import type { AccountTier, BrokeretConnector } from '../connectors/brokeret/types.js';
import type { MT5Connector } from '../connectors/mt5/types.js';
import type { UserRepository } from '../identity/repository.js';
import type { Classifier, ChatMessage, LLMClient } from '../llm/index.js';
import type { TelegramSender, TtsClient } from '../outbound/types.js';
import type { CostTracker, HaltGate, RateLimiter } from '../ops/index.js';

// ── Speech-to-text ───────────────────────────────────────────────────────────
export interface SttClient {
  /** Transcribe an audio buffer (OGG/Opus from Telegram) to text. */
  transcribe(audio: Buffer, mime?: string): Promise<string>;
}

// ── Escalation ───────────────────────────────────────────────────────────────
export type EscalationReason =
  | 'complaint'
  | 'funds_problem'
  | 'advice_demand'
  | 'repeated_guardrail_trips';

export interface EscalationEvent {
  readonly crmClientId: string;
  readonly telegramUserId: number;
  readonly reason: EscalationReason;
  readonly snippet: string;
}

export interface EscalationNotifier {
  notify(event: EscalationEvent): Promise<void>;
}

// ── Session state + store ────────────────────────────────────────────────────
export interface SessionState {
  readonly conversationId: string;
  readonly crmClientId: string;
  status: 'active' | 'closed';
  startedAt: number;
  lastActivityAt: number;
  tokenCount: number;
  exchangeCount: number;
  rollingSummary: string;
  /** Number of stored messages already folded into rollingSummary. */
  summarizedCount: number;
  guardrailTrips: number;
  escalated: boolean;
  cooldownUntil: number | null;
}

export interface StoredMessage {
  readonly direction: 'in' | 'out';
  readonly contentType: 'text' | 'voice';
  readonly content: string;
  readonly tokenCount: number;
}

export interface InboundStore {
  /** Most recent session for a client (active or closed), or null. */
  getLatestSession(crmClientId: string): Promise<SessionState | null>;
  /** Open a fresh active session. */
  openSession(crmClientId: string, nowMs: number): Promise<SessionState>;
  /** Persist mutable session fields. */
  updateSession(state: SessionState): Promise<void>;
  /** Append a message to the session. */
  recordMessage(conversationId: string, message: StoredMessage): Promise<void>;
  /** The last `limit` messages for the session, oldest-first. */
  recentMessages(conversationId: string, limit: number): Promise<StoredMessage[]>;
  /** All messages for the session, oldest-first (for summarization windows). */
  allMessages(conversationId: string): Promise<StoredMessage[]>;
}

// ── Config + deps ────────────────────────────────────────────────────────────
export interface BudgetConfig {
  readonly baseExchanges: number;
  readonly baseTokens: number;
  readonly tierMultipliers: Readonly<Record<AccountTier, number>>;
}

export interface InboundConfig {
  readonly idleResetMs: number;
  readonly cooldownMs: number;
  readonly contextWindowExchanges: number;
  readonly guardrailTripEscalationThreshold: number;
  /** Voice a reply every Nth turn (0 disables cadence voicing). Voice-in always voices. */
  readonly voiceEveryN: number;
  readonly budget: BudgetConfig;
}

export interface MetricsConnectors {
  readonly mt5: MT5Connector;
  readonly brokeret: BrokeretConnector;
}

export interface InboundDeps {
  readonly connectors: MetricsConnectors;
  readonly llm: LLMClient;
  readonly store: InboundStore;
  readonly users: UserRepository;
  readonly telegram: TelegramSender;
  readonly escalation: EscalationNotifier;
  readonly tts?: TtsClient;
  readonly stt?: SttClient;
  readonly classifier?: Classifier;
  // Production hardening (all optional — absent ⇒ feature off).
  readonly halt?: HaltGate;
  readonly rateLimiter?: RateLimiter;
  readonly cost?: CostTracker;
  readonly config: InboundConfig;
  readonly clock: { now(): number };
}

// ── Message I/O ──────────────────────────────────────────────────────────────
export type InboundContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'voice'; readonly audio: Buffer; readonly mime?: string };

export interface InboundMessage {
  readonly telegramUserId: number;
  readonly content: InboundContent;
}

export type InboundStatus =
  | 'unbound'
  | 'cooldown'
  | 'escalated'
  | 'exit'
  | 'lookup'
  | 'mentor'
  | 'halted'
  | 'throttled'
  | 'cost_exit'
  | 'degraded';

export type BudgetBand = 'normal' | 'tighten' | 'cap';

export interface InboundResult {
  readonly status: InboundStatus;
  readonly reply: string;
  readonly voiced: boolean;
  readonly guardrailTripped: boolean;
  readonly llmCalled: boolean;
  readonly band: BudgetBand | null;
  readonly escalationReason?: EscalationReason;
}

export type { ChatMessage };
