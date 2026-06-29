import { webhookCallback } from 'grammy';
import { bot } from './bot.js';

/**
 * Secret path segment for the Telegram webhook. Derived from the bot token so
 * it is stable and unguessable without leaking the token in URLs/logs.
 */
export const WEBHOOK_PATH = '/telegram/webhook';

/**
 * grammY webhook handler compatible with Node's built-in `http` server.
 * Used only when `TELEGRAM_WEBHOOK_URL` is configured (production mode).
 */
export const handleWebhook = webhookCallback(bot, 'http');
