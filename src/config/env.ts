import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Load environment variables from a local `.env` file if present.
 *
 * Uses Node's built-in env-file loader (Node >= 20.6) so we don't need a
 * `dotenv` dependency. In production (Railway) the variables come from the
 * platform's environment and no `.env` file exists — that's expected.
 */
function loadDotEnv(): void {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
}

loadDotEnv();

const nonEmpty = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .trim()
    .min(1, `${name} must not be empty`);

/** Parse a boolean-ish env string (`true/1/yes/on`), defaulting when unset. */
const boolFromEnv = (defaultValue: boolean) =>
  z.preprocess((raw) => {
    if (raw === undefined || raw === '') return defaultValue;
    if (typeof raw === 'string') return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
    return Boolean(raw);
  }, z.boolean());

const envSchema = z
  .object({
    // Telegram
    TELEGRAM_BOT_TOKEN: nonEmpty('TELEGRAM_BOT_TOKEN'),

    // Supabase
    SUPABASE_URL: nonEmpty('SUPABASE_URL').url('SUPABASE_URL must be a valid URL'),
    SUPABASE_SERVICE_KEY: nonEmpty('SUPABASE_SERVICE_KEY'),

    // Connector selection: mock vs real. Defaults to mock while we build
    // against fixtures (awaiting MT5 Manager API / Brokeret CRM API docs).
    USE_MOCK_CONNECTORS: boolFromEnv(true),

    // MT5 + Brokeret API credentials. Optional while USE_MOCK_CONNECTORS=true;
    // enforced below (superRefine) only when real connectors are selected.
    MT5_API_URL: z.string().url('MT5_API_URL must be a valid URL').optional(),
    MT5_API_KEY: z.string().min(1).optional(),
    BROKERET_API_URL: z.string().url('BROKERET_API_URL must be a valid URL').optional(),
    BROKERET_API_KEY: z.string().min(1).optional(),

    // Connector wrapper tuning (retry + short-TTL cache).
    CONNECTOR_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(15_000),
    CONNECTOR_MAX_RETRIES: z.coerce.number().int().min(1).default(3),

    // LLM (Claude / Anthropic)
    LLM_API_KEY: nonEmpty('LLM_API_KEY'),
    LLM_MENTOR_MODEL: z.string().trim().min(1).default('claude-opus-4-8'),
    LLM_CLASSIFIER_MODEL: z.string().trim().min(1).default('claude-haiku-4-5'),
    LLM_MENTOR_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
    LLM_MENTOR_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),

    // ElevenLabs (voice)
    ELEVENLABS_API_KEY: nonEmpty('ELEVENLABS_API_KEY'),
    ELEVENLABS_VOICE_ID: z.string().trim().min(1).optional(),
    ELEVENLABS_MODEL_ID: z.string().trim().min(1).default('eleven_multilingual_v2'),

    // Daily report (outbound)
    DAILY_VOICE_ENABLED: boolFromEnv(true),
    DAILY_REPORT_HOUR: z.coerce.number().int().min(0).max(23).default(7),
    DAILY_REPORT_GRANULARITY: z.enum(['daily', 'weekly']).default('daily'),

    // Marketing campaigns (outbound)
    MARKETING_HOUR_LOCAL: z.coerce.number().int().min(0).max(23).default(10),
    MARKETING_WEEKLY_CAP: z.coerce.number().int().min(0).default(3),

    // Production hardening
    SYSTEM_HALT: boolFromEnv(false), // kill switch — halts ALL outbound + AI replies
    COST_GLOBAL_DAILY_USD: z.coerce.number().nonnegative().default(100),
    COST_USER_DAILY_USD: z.coerce.number().nonnegative().default(5), // bronze base; scaled by tier
    INBOUND_RATE_MAX: z.coerce.number().int().positive().default(20),
    INBOUND_RATE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

    // Inbound chat — speech-to-text + voice cadence + escalation channel
    STT_PROVIDER: z.enum(['whisper', 'deepgram']).default('whisper'),
    OPENAI_API_KEY: z.string().trim().min(1).optional(), // Whisper
    DEEPGRAM_API_KEY: z.string().trim().min(1).optional(),
    CHAT_VOICE_EVERY_N: z.coerce.number().int().min(0).default(4),
    ESCALATION_CHAT_ID: z.coerce.number().int().optional(),

    // Redis / BullMQ
    REDIS_URL: nonEmpty('REDIS_URL'),

    // Identity signing
    IDENTITY_SIGNING_SECRET: nonEmpty('IDENTITY_SIGNING_SECRET'),

    // Shared secret the Brokeret CRM presents to mint connect links
    // (client↔server auth handshake for the internal link endpoint).
    CRM_SHARED_SECRET: nonEmpty('CRM_SHARED_SECRET'),

    // Bot username (without @) used to build t.me deep links. Optional: falls
    // back to the value fetched from Telegram once the bot is initialised.
    TELEGRAM_BOT_USERNAME: z.string().trim().min(1).optional(),

    // Connect-link lifetime (default 15 minutes).
    CONNECT_LINK_TTL_MS: z.coerce.number().int().positive().default(900_000),

    // Optional runtime config (sensible defaults)
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    PORT: z.coerce.number().int().positive().default(3000),
    TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.USE_MOCK_CONNECTORS) {
      const required = ['MT5_API_URL', 'MT5_API_KEY', 'BROKERET_API_URL', 'BROKERET_API_KEY'] as const;
      for (const key of required) {
        if (!val[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when USE_MOCK_CONNECTORS=false`,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validate `process.env` against the schema. Throws (fails fast) with a
 * human-readable list of every missing/invalid variable.
 */
function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(
      `\n✖ Invalid environment configuration:\n${issues}\n\n` +
        `See .env.example for the full list of required variables.\n`,
    );
    process.exit(1);
  }

  return result.data;
}

export const env: Env = parseEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
