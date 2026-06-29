import { Bot } from 'grammy';
import { env } from '../config/env.js';
import { brokeret } from '../config/connectors.js';
import { AuthorizationError, ConflictError, NotFoundError } from '../lib/errors.js';
import { childLogger } from '../lib/logger.js';
import { bindTelegramUser, requireBoundUser, userRepository } from '../identity/index.js';
import type { BotContext } from './context.js';

const log = childLogger('bot');

/** The grammY bot instance (typed with {@link BotContext}). */
export const bot = new Bot<BotContext>(env.TELEGRAM_BOT_TOKEN);

const WELCOME_NO_TOKEN =
  '👋 Welcome to Milele Prime AI.\n\n' +
  'To link your account, tap the Connect button in your Milele dashboard.';

const BIND_SUCCESS = '✅ Your Telegram is now linked to your Milele account. You can also enable voice and daily reports from your dashboard.';
const BIND_ALREADY = '✅ Your account is already linked — you’re all set.';
const BIND_EXPIRED = '⏳ That connect link has expired. Please open a fresh Connect link from your Milele dashboard.';
const BIND_INVALID = '⚠️ That connect link is invalid. Please use the Connect button in your Milele dashboard.';
const BIND_CONFLICT = '⚠️ This account is already linked to a different profile. Please contact support.';
const BIND_ERROR = '⚠️ Something went wrong linking your account. Please try again shortly.';

/** Resolve the bot username for deep links (env override → fetched botInfo). */
export function getBotUsername(): string | undefined {
  if (env.TELEGRAM_BOT_USERNAME) return env.TELEGRAM_BOT_USERNAME;
  try {
    return bot.botInfo.username;
  } catch {
    return undefined;
  }
}

function registerHandlers(): void {
  // /start — identity binding. `ctx.match` holds the deep-link start payload.
  bot.command('start', async (ctx) => {
    const token = ctx.match?.trim();
    const telegramUserId = ctx.from?.id;

    if (!token || telegramUserId === undefined) {
      await ctx.reply(WELCOME_NO_TOKEN);
      return;
    }

    try {
      const result = await bindTelegramUser(
        { repo: userRepository, brokeret },
        { token, telegramUserId },
      );
      await ctx.reply(result.status === 'bound' ? BIND_SUCCESS : BIND_ALREADY);
    } catch (err) {
      if (err instanceof AuthorizationError) {
        await ctx.reply(/expired/i.test(err.message) ? BIND_EXPIRED : BIND_INVALID);
      } else if (err instanceof ConflictError) {
        await ctx.reply(BIND_CONFLICT);
      } else if (err instanceof NotFoundError) {
        await ctx.reply(BIND_INVALID);
      } else {
        log.error({ err, telegramUserId }, 'Unexpected error during bind');
        await ctx.reply(BIND_ERROR);
      }
    }
  });

  // Example data-touching handler — gated by requireBoundUser.
  bot.command('account', requireBoundUser(userRepository), async (ctx) => {
    // ctx.boundUser is guaranteed present here.
    await ctx.reply(
      `🔗 Linked to client ${ctx.boundUser?.crmClientId}. Account features arrive in a later phase.`,
    );
  });

  bot.catch((err) => {
    log.error({ err: err.error, updateId: err.ctx.update.update_id }, 'Unhandled bot error');
  });
}

registerHandlers();

// Conversational chat handlers (text + voice) are registered separately by the
// app entrypoint via `registerChatHandlers` so command handlers run first.
