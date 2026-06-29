/**
 * ElevenLabs TTS → OGG/Opus, for native Telegram voice notes. One consistent
 * "Milele mentor" voice. Input is the narrative TEXT (never the PDF).
 *
 * `opus_48000_*` returns an OGG/Opus stream — exactly the codec Telegram needs
 * for a message to render as a voice note rather than an audio file.
 */
import { env } from '../config/env.js';
import { ConfigError, ExternalServiceError } from '../lib/errors.js';
import type { TtsClient, TtsResult } from './types.js';

const DEFAULT_FORMAT = 'opus_48000_64';

export interface ElevenLabsOptions {
  readonly apiKey?: string;
  readonly voiceId?: string;
  readonly modelId?: string;
  readonly outputFormat?: string;
}

export function createElevenLabsTts(options: ElevenLabsOptions = {}): TtsClient {
  const apiKey = options.apiKey ?? env.ELEVENLABS_API_KEY;
  const voiceId = options.voiceId ?? env.ELEVENLABS_VOICE_ID;
  const modelId = options.modelId ?? env.ELEVENLABS_MODEL_ID;
  const outputFormat = options.outputFormat ?? DEFAULT_FORMAT;

  return {
    async synthesize(text: string): Promise<TtsResult> {
      if (!voiceId) {
        throw new ConfigError('ELEVENLABS_VOICE_ID is required to synthesize voice notes');
      }
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/ogg' },
        body: JSON.stringify({ text, model_id: modelId }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ExternalServiceError(`ElevenLabs TTS failed (${res.status})`, {
          status: res.status,
          body: body.slice(0, 200),
        });
      }
      const audio = Buffer.from(await res.arrayBuffer());
      return { audio, format: 'ogg-opus', charCount: text.length };
    },
  };
}
