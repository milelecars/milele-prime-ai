/**
 * Shared LLM module — used by the daily report (Phase 4) and two-way chat
 * (Phase 5). Mentor prompt, post-generation guardrail, and a thin client.
 */
import { env } from '../config/env.js';
import { createAnthropicTransport } from './anthropic-transport.js';
import { LLMClient } from './client.js';

export {
  MENTOR_SYSTEM_PROMPT,
  GUARDRAIL_PROMPT,
  CLASSIFIER_SYSTEM_PROMPT,
  SUMMARIZER_SYSTEM_PROMPT,
  TIGHTEN_DIRECTIVE,
  buildMentorSystem,
  languageDirective,
} from './prompts.js';
export { LLMClient } from './client.js';
export type { LLMClientConfig, MentorRequest, MentorResult } from './client.js';
export { createAnthropicTransport } from './anthropic-transport.js';
export {
  checkOutbound,
  guardrailAuditEvent,
  type Classifier,
  type ClassifierVerdict,
  type CheckOptions,
  type GuardrailResult,
  type GuardrailTrip,
} from './guardrail.js';
export { scanRules, type GuardrailCategory, type RuleHit } from './rules.js';
export { buildDeflection, buildDeterministicReport } from './deflection.js';
export type {
  ChatMessage,
  ChatRole,
  CompletionRequest,
  CompletionResult,
  CountRequest,
  Effort,
  LLMTransport,
  TokenUsage,
} from './types.js';

/** Build the production LLM client (Claude-backed, configured from env). */
export function createLLMClient(): LLMClient {
  return new LLMClient({
    transport: createAnthropicTransport(),
    mentorModel: env.LLM_MENTOR_MODEL,
    classifierModel: env.LLM_CLASSIFIER_MODEL,
    mentorMaxTokens: env.LLM_MENTOR_MAX_TOKENS,
    ...(env.LLM_MENTOR_EFFORT ? { mentorEffort: env.LLM_MENTOR_EFFORT } : {}),
  });
}
