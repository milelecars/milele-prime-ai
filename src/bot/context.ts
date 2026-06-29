import type { Context } from 'grammy';
import type { UserRecord } from '../identity/repository.js';

/**
 * Application bot context. `boundUser` is populated by the `requireBoundUser`
 * middleware for handlers that touch account data.
 */
export interface BotContext extends Context {
  boundUser?: UserRecord;
}
