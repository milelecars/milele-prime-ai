/** grammY-backed {@link TelegramSender}. Voice notes use OGG/Opus InputFiles. */
import { InputFile } from 'grammy';
import { bot } from '../bot/bot.js';
import type { OutboundAttachment, TelegramSender } from './types.js';

type BotApi = typeof bot.api;

export function createTelegramSender(api: BotApi = bot.api): TelegramSender {
  return {
    async sendText(chatId: number, text: string): Promise<void> {
      await api.sendMessage(chatId, text);
    },
    async sendDocument(chatId: number, doc: OutboundAttachment, caption?: string): Promise<void> {
      await api.sendDocument(
        chatId,
        new InputFile(doc.buffer, doc.filename),
        caption !== undefined ? { caption } : {},
      );
    },
    async sendPhoto(chatId: number, photo: OutboundAttachment, caption?: string): Promise<void> {
      await api.sendPhoto(
        chatId,
        new InputFile(photo.buffer, photo.filename),
        caption !== undefined ? { caption } : {},
      );
    },
    async sendVoice(chatId: number, voice: OutboundAttachment, caption?: string): Promise<void> {
      // OGG/Opus → renders as a native voice note (not a file).
      await api.sendVoice(
        chatId,
        new InputFile(voice.buffer, voice.filename),
        caption !== undefined ? { caption } : {},
      );
    },
  };
}
