/**
 * Production {@link LLMTransport} backed by the Anthropic SDK (Claude).
 *
 * Kept behind the transport interface so the rest of the module — and all
 * tests — never touch the network. Construct via {@link createAnthropicTransport}.
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import type { CompletionRequest, CompletionResult, CountRequest, LLMTransport } from './types.js';

export function createAnthropicTransport(apiKey: string = env.LLM_API_KEY): LLMTransport {
  const client = new Anthropic({ apiKey });

  return {
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      // `output_config.effort` is GA but not yet in this SDK version's types —
      // attach it via a typed-safe extra field.
      const params: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      };
      if (req.effort) params['output_config'] = { effort: req.effort };

      const res = await client.messages.create(
        params as unknown as Anthropic.MessageCreateParamsNonStreaming,
      );

      const text = res.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');

      return {
        text,
        stopReason: res.stop_reason ?? null,
        usage: {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
        },
      };
    },

    async countTokens(req: CountRequest): Promise<number> {
      const res = await client.messages.countTokens({
        model: req.model,
        ...(req.system ? { system: req.system } : {}),
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      return res.input_tokens;
    },
  };
}
