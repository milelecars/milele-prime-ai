import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { env } from '../config/env.js';
import { brokeret } from '../config/connectors.js';
import { AuthorizationError, ConflictError, NotFoundError } from '../lib/errors.js';
import { childLogger } from '../lib/logger.js';
import { toError } from '../lib/utils.js';
import { bindTelegramUser, requireBoundUser, userRepository } from '../identity/index.js';
// TEMP (/report preview) — mock connectors + the report pipeline.
import { MockMT5Connector } from '../connectors/mt5/mock.js';
import { MockBrokeretConnector } from '../connectors/brokeret/mock.js';
import { gatherMetricsInput, computeClientMetrics } from '../metrics/index.js';
import { buildDeterministicReport } from '../llm/index.js';
import { buildDailyReportPdf } from '../outbound/pdf.js';
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  languageNative,
  SUPPORTED_LANGUAGES,
  t,
  type Language,
} from '../i18n/index.js';
import type { BotContext } from './context.js';

const log = childLogger('bot');

/** The grammY bot instance (typed with {@link BotContext}). */
export const bot = new Bot<BotContext>(env.TELEGRAM_BOT_TOKEN);

/** Inline keyboard of the supported languages (two per row). */
function languageKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  SUPPORTED_LANGUAGES.forEach((l, i) => {
    kb.text(l.native, `lang:${l.code}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

/** Best-effort lookup of a Telegram user's chosen language (default English). */
async function resolveLanguage(telegramUserId: number | undefined): Promise<Language> {
  if (telegramUserId === undefined) return DEFAULT_LANGUAGE;
  try {
    const user = await userRepository.getByTelegramId(telegramUserId);
    return user?.language ?? DEFAULT_LANGUAGE;
  } catch (err) {
    log.warn({ err: toError(err), telegramUserId }, 'Failed to resolve user language');
    return DEFAULT_LANGUAGE;
  }
}

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
      // Not-yet-bound users have no stored preference — greet in English.
      await ctx.reply(t(DEFAULT_LANGUAGE).welcome);
      return;
    }

    try {
      const result = await bindTelegramUser(
        { repo: userRepository, brokeret },
        { token, telegramUserId },
      );
      // Reply in the user's language if they already chose one (re-bind); a
      // fresh bind has none yet, so this is English until they pick below.
      const s = t(await resolveLanguage(telegramUserId));
      await ctx.reply(result.status === 'bound' ? s.bindSuccess : s.bindAlready);
      // Greet + ask them to pick their preferred chat language.
      await ctx.reply(s.chooseLanguage, { reply_markup: languageKeyboard() });
    } catch (err) {
      const s = t(DEFAULT_LANGUAGE);
      if (err instanceof AuthorizationError) {
        await ctx.reply(/expired/i.test(err.message) ? s.bindExpired : s.bindInvalid);
      } else if (err instanceof ConflictError) {
        await ctx.reply(s.bindConflict);
      } else if (err instanceof NotFoundError) {
        await ctx.reply(s.bindInvalid);
      } else {
        log.error({ err, telegramUserId }, 'Unexpected error during bind');
        await ctx.reply(s.bindError);
      }
    }
  });

  // /language — let a bound user (re)choose their preferred chat language.
  bot.command('language', requireBoundUser(userRepository), async (ctx) => {
    const s = t(ctx.boundUser?.language ?? DEFAULT_LANGUAGE);
    await ctx.reply(s.chooseLanguage, { reply_markup: languageKeyboard() });
  });

  // Language selection from the inline keyboard (`lang:<code>`).
  bot.callbackQuery(/^lang:(.+)$/, async (ctx) => {
    const code = ctx.match?.[1];
    const telegramUserId = ctx.from?.id;
    if (!isLanguage(code) || telegramUserId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    try {
      const user = await userRepository.getByTelegramId(telegramUserId);
      if (!user || user.telegramUserId === null) {
        // Not bound — can't persist a preference against a client.
        await ctx.answerCallbackQuery();
        await ctx.reply(t(DEFAULT_LANGUAGE).unbound);
        return;
      }
      await userRepository.setLanguage(user.crmClientId, code);
      await ctx.answerCallbackQuery();
      const confirmation = t(code).languageSet(languageNative(code));
      // Replace the picker with the confirmation; fall back to a fresh message.
      await ctx.editMessageText(confirmation).catch(() => ctx.reply(confirmation));
    } catch (err) {
      log.error({ err: toError(err), telegramUserId }, 'Failed to set language');
      await ctx.answerCallbackQuery();
    }
  });

  // Example data-touching handler — gated by requireBoundUser.
  bot.command('account', requireBoundUser(userRepository), async (ctx) => {
    // ctx.boundUser is guaranteed present here.
    const s = t(ctx.boundUser?.language ?? DEFAULT_LANGUAGE);
    await ctx.reply(s.accountLinked(ctx.boundUser?.crmClientId ?? ''));
  });

  // ── TEMP: /report — on-demand preview of the daily drop (mock data) ─────────
  // Usage: `/report [crmClientId] [YYYY-MM-DD]`  (defaults: crm-1001 2025-06-19).
  // Renders exactly what a user receives — the narrative text + branded PDF —
  // straight to whoever runs it. Bypasses the scheduler/store/LLM/consent, so it
  // works with no infra and never double-sends. REMOVE before production.
  // Mock personas: crm-1001 winner · crm-1002 loser · crm-1003 weekend-holder
  //                crm-1004 no-trades · crm-1005 open-only.
  bot.command('report', async (ctx) => {
    const [idArg, dateArg] = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);
    const crmClientId = idArg || 'crm-1001';
    const referenceDate = dateArg || '2025-06-19';
    try {
      const connectors = { mt5: new MockMT5Connector(), brokeret: new MockBrokeretConnector() };
      const client = await connectors.brokeret.getClient(crmClientId);
      const login = client.mt5Logins[0];
      const input = await gatherMetricsInput(connectors, {
        crmClientId,
        granularity: 'daily',
        referenceDate,
        includePrior: true,
      });
      const metrics = computeClientMetrics(input);
      const account = login !== undefined ? await connectors.mt5.getAccountSummary(login) : undefined;
      const pdf = await buildDailyReportPdf(metrics, client, account);

      await ctx.reply(buildDeterministicReport(metrics));
      await ctx.replyWithDocument(new InputFile(pdf, `milele-${referenceDate}.pdf`), {
        caption: `Milele Prime — daily report · ${referenceDate} (preview · mock data)`,
      });
    } catch (err) {
      log.error({ err: toError(err), crmClientId, referenceDate }, 'TEMP /report preview failed');
      await ctx.reply(
        `Couldn't build a report for "${crmClientId}" @ ${referenceDate}.\n` +
          `Try: /report crm-1002 2025-06-20  (personas: crm-1001..crm-1005)`,
      );
    }
  });

  bot.catch((err) => {
    log.error({ err: err.error, updateId: err.ctx.update.update_id }, 'Unhandled bot error');
  });
}

registerHandlers();

// Conversational chat handlers (text + voice) are registered separately by the
// app entrypoint via `registerChatHandlers` so command handlers run first.
