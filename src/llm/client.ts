/**
 * Thin LLM client wrapper. Two jobs:
 *   - `mentorCompletion`: full mentor turn (system prompt + metrics + chat).
 *   - `classifyOutbound`: cheap classifier call for the guardrail backstop.
 *
 * Token counting is centralized here so callers can track usage. All
 * user-supplied text is treated as untrusted: it travels only as `user` turns
 * in the messages array and is NEVER merged into the system prompt or the
 * guardrail, so it cannot override either.
 */
import { childLogger } from '../lib/logger.js';
import type { ClientMetrics } from '../metrics/types.js';
import type { ClassifierVerdict } from './guardrail.js';
import { buildMentorSystem, CLASSIFIER_SYSTEM_PROMPT, SUMMARIZER_SYSTEM_PROMPT } from './prompts.js';
import type {
  ChatMessage,
  CompletionResult,
  Effort,
  LLMTransport,
  TokenUsage,
} from './types.js';

const log = childLogger('llm:client');

export interface LLMClientConfig {
  readonly transport: LLMTransport;
  readonly mentorModel: string;
  readonly classifierModel: string;
  readonly mentorMaxTokens: number;
  readonly mentorEffort?: Effort;
  readonly classifierMaxTokens?: number;
}

export interface MentorRequest {
  readonly metrics: ClientMetrics;
  /** Prior conversation. User text is untrusted and stays in messages only. */
  readonly conversation: readonly ChatMessage[];
  /**
   * Trusted, server-controlled context appended to the system prompt — e.g. a
   * rolling conversation summary or a "tighten and wind down" directive. Never
   * raw user text.
   */
  readonly systemAppendix?: string;
}

export interface MentorResult {
  readonly text: string;
  readonly stopReason: string | null;
  readonly usage: TokenUsage;
}

function parseVerdict(raw: string): ClassifierVerdict {
  // Be lenient: extract the first JSON object from the model's text.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { forbidden: false, category: null, reason: 'unparseable classifier output' };
  try {
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      forbidden: Boolean(obj['forbidden']),
      category: typeof obj['category'] === 'string' ? obj['category'] : null,
      reason: typeof obj['reason'] === 'string' ? obj['reason'] : null,
    };
  } catch {
    return { forbidden: false, category: null, reason: 'invalid classifier JSON' };
  }
}

export class LLMClient {
  constructor(private readonly config: LLMClientConfig) {}

  /** Generate a mentor turn. Returns the text plus token usage. */
  async mentorCompletion(req: MentorRequest): Promise<MentorResult> {
    const base = buildMentorSystem(req.metrics);
    const system = req.systemAppendix
      ? `${base}\n\n## Conversation context\n${req.systemAppendix}`
      : base;
    const result: CompletionResult = await this.config.transport.complete({
      model: this.config.mentorModel,
      system,
      messages: req.conversation,
      maxTokens: this.config.mentorMaxTokens,
      ...(this.config.mentorEffort ? { effort: this.config.mentorEffort } : {}),
    });
    if (result.stopReason === 'refusal') {
      log.warn({ crmClientId: req.metrics.crmClientId }, 'Mentor completion refused');
    }
    return { text: result.text, stopReason: result.stopReason, usage: result.usage };
  }

  /** Update a rolling conversation summary (cheap classifier-tier model). */
  async summarize(previousSummary: string, turns: readonly ChatMessage[]): Promise<string> {
    const body = turns.map((t) => `${t.role}: ${t.content}`).join('\n');
    const result = await this.config.transport.complete({
      model: this.config.classifierModel,
      system: SUMMARIZER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `<<<PREVIOUS_SUMMARY>>>\n${previousSummary || '(none)'}\n<<<NEW_EXCHANGES>>>\n${body}\n<<<END>>>`,
        },
      ],
      maxTokens: this.config.classifierMaxTokens ?? 300,
    });
    return result.text.trim();
  }

  /** Classify candidate output for the guardrail backstop. */
  async classifyOutbound(text: string): Promise<ClassifierVerdict> {
    const result = await this.config.transport.complete({
      model: this.config.classifierModel,
      system: CLASSIFIER_SYSTEM_PROMPT,
      // The candidate is untrusted data — delivered as a user turn, framed.
      messages: [{ role: 'user', content: `<<<CANDIDATE>>>\n${text}\n<<<END>>>` }],
      maxTokens: this.config.classifierMaxTokens ?? 200,
    });
    return parseVerdict(result.text);
  }

  /** Count tokens for an arbitrary string (mentor model tokenizer). */
  async countText(text: string): Promise<number> {
    return this.config.transport.countTokens({
      model: this.config.mentorModel,
      messages: [{ role: 'user', content: text }],
    });
  }

  /** Count tokens for a full mentor request (system + conversation). */
  async countMentorRequest(req: MentorRequest): Promise<number> {
    return this.config.transport.countTokens({
      model: this.config.mentorModel,
      system: buildMentorSystem(req.metrics),
      messages: req.conversation,
    });
  }
}
