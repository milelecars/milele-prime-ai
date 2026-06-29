/**
 * Speech-to-text clients. Provider is configurable (Whisper or Deepgram).
 * Network boundary only — injected, so the pipeline tests stay offline.
 */
import { env } from '../config/env.js';
import { ConfigError, ExternalServiceError } from '../lib/errors.js';
import type { SttClient } from './types.js';

export function createWhisperStt(apiKey: string | undefined = env.OPENAI_API_KEY): SttClient {
  return {
    async transcribe(audio: Buffer, mime = 'audio/ogg'): Promise<string> {
      if (!apiKey) throw new ConfigError('OPENAI_API_KEY is required for Whisper STT');
      const form = new FormData();
      form.append('file', new Blob([audio], { type: mime }), 'voice.ogg');
      form.append('model', 'whisper-1');
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) {
        throw new ExternalServiceError(`Whisper STT failed (${res.status})`, { status: res.status });
      }
      const json = (await res.json()) as { text?: string };
      return json.text ?? '';
    },
  };
}

export function createDeepgramStt(apiKey: string | undefined = env.DEEPGRAM_API_KEY): SttClient {
  return {
    async transcribe(audio: Buffer, mime = 'audio/ogg'): Promise<string> {
      if (!apiKey) throw new ConfigError('DEEPGRAM_API_KEY is required for Deepgram STT');
      const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true', {
        method: 'POST',
        headers: { authorization: `Token ${apiKey}`, 'content-type': mime },
        body: new Uint8Array(audio),
      });
      if (!res.ok) {
        throw new ExternalServiceError(`Deepgram STT failed (${res.status})`, { status: res.status });
      }
      const json = (await res.json()) as {
        results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
      };
      return json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    },
  };
}

/** Build the configured STT client. */
export function createSttClient(provider: 'whisper' | 'deepgram' = env.STT_PROVIDER): SttClient {
  return provider === 'deepgram' ? createDeepgramStt() : createWhisperStt();
}
