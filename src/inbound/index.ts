/** Inbound conversational mentor (Phase 5). */
export { handleInbound } from './handleMessage.js';
export { InMemoryInboundStore, SupabaseInboundStore } from './store.js';
export { tryLookup } from './routing.js';
export { detectEscalation } from './escalation.js';
export { buildExitMessage, buildCooldownMessage } from './exit.js';
export { capsForTier, budgetRatio, bandForRatio, estimateTokens } from './budget.js';
export { createWhisperStt, createDeepgramStt, createSttClient } from './stt.js';
export {
  inboundConfig,
  createInboundDeps,
  createEscalationNotifier,
  registerChatHandlers,
} from './runtime.js';
export type {
  BudgetBand,
  BudgetConfig,
  EscalationEvent,
  EscalationNotifier,
  EscalationReason,
  InboundConfig,
  InboundContent,
  InboundDeps,
  InboundMessage,
  InboundResult,
  InboundStatus,
  InboundStore,
  SessionState,
  SttClient,
  StoredMessage,
} from './types.js';
