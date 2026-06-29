/** Transport-level types for the LLM client. */

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface CompletionRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
  readonly effort?: Effort;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly stopReason: string | null;
  readonly usage: TokenUsage;
}

export interface CountRequest {
  readonly model: string;
  readonly system?: string;
  readonly messages: readonly ChatMessage[];
}

/**
 * Minimal transport the {@link LLMClient} depends on. The production
 * implementation wraps the Anthropic SDK; tests inject a fake. Keeping this
 * narrow is what makes the whole module testable offline.
 */
export interface LLMTransport {
  complete(req: CompletionRequest): Promise<CompletionResult>;
  countTokens(req: CountRequest): Promise<number>;
}
