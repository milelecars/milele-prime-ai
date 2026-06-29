/**
 * Production wiring for the inbound chat mentor: the real dependency bundle and
 * the grammY message handlers (text + voice). Kept separate from the core so
 * the pipeline stays testable against fakes.
 */
import { bot } from '../bot/bot.js';
import { brokeret, mt5 } from '../config/connectors.js';
import { env } from '../config/env.js';
import { supabase } from '../db/supabase.js';
import { userRepository } from '../identity/index.js';
import { childLogger } from '../lib/logger.js';
import { toError } from '../lib/utils.js';
import { createLLMClient } from '../llm/index.js';
import { createCostTracker, createRateLimiter, haltGate } from '../ops/wiring.js';
import { createElevenLabsTts } from '../outbound/tts.js';
import { createTelegramSender } from '../outbound/telegram.js';
import { handleInbound } from './handleMessage.js';
import { SupabaseInboundStore } from './store.js';
import { createSttClient } from './stt.js';
import type { EscalationEvent, EscalationNotifier, InboundConfig, InboundDeps } from './types.js';

const log = childLogger('inbound:runtime');

export function inboundConfig(): InboundConfig {
  return {
    idleResetMs: 15 * 60 * 1000,
    cooldownMs: 10 * 60 * 1000,
    contextWindowExchanges: 4,
    guardrailTripEscalationThreshold: 3,
    voiceEveryN: env.CHAT_VOICE_EVERY_N,
    budget: {
      baseExchanges: 14,
      baseTokens: 9_000,
      tierMultipliers: { bronze: 1, silver: 1.25, gold: 1.5, platinum: 2 },
    },
  };
}

/** Notify an internal Telegram channel and write an audit-log entry. */
export function createEscalationNotifier(): EscalationNotifier {
  return {
    async notify(event: EscalationEvent): Promise<void> {
      await userRepository.appendAudit({
        crmClientId: event.crmClientId,
        eventType: 'escalation',
        detail: { reason: event.reason, telegramUserId: event.telegramUserId, snippet: event.snippet.slice(0, 280) },
      });
      if (env.ESCALATION_CHAT_ID !== undefined) {
        const msg = `🚩 Escalation (${event.reason}) — client ${event.crmClientId}, tg ${event.telegramUserId}\n"${event.snippet.slice(0, 200)}"`;
        await bot.api.sendMessage(env.ESCALATION_CHAT_ID, msg).catch((err) => {
          log.error({ err: toError(err) }, 'Failed to post escalation to internal channel');
        });
      }
    },
  };
}

/** Build the full production deps bundle. */
export function createInboundDeps(): InboundDeps {
  const llm = createLLMClient();
  return {
    connectors: { mt5, brokeret },
    llm,
    store: new SupabaseInboundStore(supabase),
    users: userRepository,
    telegram: createTelegramSender(),
    escalation: createEscalationNotifier(),
    tts: createElevenLabsTts(),
    stt: createSttClient(),
    classifier: (text: string) => llm.classifyOutbound(text),
    halt: haltGate(),
    rateLimiter: createRateLimiter(),
    cost: createCostTracker(),
    config: inboundConfig(),
    clock: { now: () => Date.now() },
  };
}

/** Register chat message handlers (text + voice) on the bot. */
export function registerChatHandlers(deps: InboundDeps = createInboundDeps()): void {
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) return next();
    const telegramUserId = ctx.from?.id;
    if (telegramUserId === undefined) return;
    try {
      await handleInbound(deps, { telegramUserId, content: { type: 'text', text: ctx.message.text } });
    } catch (err) {
      log.error({ err: toError(err), telegramUserId }, 'Inbound text handling failed');
    }
  });

  bot.on('message:voice', async (ctx) => {
    const telegramUserId = ctx.from?.id;
    if (telegramUserId === undefined) return;
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path ?? ''}`;
      const audio = Buffer.from(await (await fetch(url)).arrayBuffer());
      await handleInbound(deps, {
        telegramUserId,
        content: { type: 'voice', audio, mime: 'audio/ogg' },
      });
    } catch (err) {
      log.error({ err: toError(err), telegramUserId }, 'Inbound voice handling failed');
    }
  });

  log.info('Chat handlers registered');
}
