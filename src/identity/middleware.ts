import type { NextFunction } from 'grammy';
import type { BotContext } from '../bot/context.js';
import { childLogger } from '../lib/logger.js';
import type { UserRepository } from './repository.js';

const log = childLogger('identity:middleware');

export const UNBOUND_MESSAGE =
  'Tap the Connect button in your Milele dashboard to link your account.';

/**
 * grammY middleware: only allow data-touching handlers to run for a Telegram
 * user that is bound to a CRM client. Unbound users are refused with a clear
 * instruction and never served account data.
 *
 * On success it attaches the resolved {@link BotContext.boundUser}.
 */
export function requireBoundUser(repo: UserRepository) {
  return async (ctx: BotContext, next: NextFunction): Promise<void> => {
    const telegramUserId = ctx.from?.id;
    if (telegramUserId === undefined) {
      await ctx.reply(UNBOUND_MESSAGE);
      return;
    }

    const user = await repo.getByTelegramId(telegramUserId);
    if (!user || user.telegramUserId === null) {
      log.debug({ telegramUserId }, 'Refused unbound user');
      await ctx.reply(UNBOUND_MESSAGE);
      return;
    }

    ctx.boundUser = user;
    await next();
  };
}
