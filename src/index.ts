import type { Server } from 'node:http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { toError } from './lib/utils.js';
import { isOperationalError } from './lib/errors.js';
import { bot } from './bot/bot.js';
import { WEBHOOK_PATH } from './bot/webhook.js';
import { startHttpServer, registerMarketingApi, registerHaltControl } from './server.js';
import { haltGate, seedHalt } from './ops/wiring.js';
import { closeQueues, outboundQueue } from './queue/index.js';
import {
  createDailyReportWorker,
  createMarketingDeps,
  selectSegment,
  scheduleCampaign,
  type Campaign,
  type MarketingPayload,
  type Segment,
} from './outbound/index.js';
import { registerChatHandlers } from './inbound/index.js';
import type { Worker } from 'bullmq';

const log = logger.child({ component: 'main' });

let httpServer: Server | undefined;
let dailyReportWorker: Worker | undefined;

async function start(): Promise<void> {
  httpServer = await startHttpServer();

  // Kill switch — seed from env and expose the admin control.
  const gate = haltGate();
  await seedHalt().catch((err) => log.error({ err }, 'Failed to seed halt flag'));
  registerHaltControl({ get: () => gate.isHalted(), set: (v) => gate.set(v) });

  // Register conversational chat handlers (text + voice) before the bot starts.
  try {
    registerChatHandlers();
  } catch (err) {
    log.error({ err }, 'Failed to register chat handlers (continuing)');
  }

  // Wire the marketing admin API (dry-run + schedule) into the HTTP server.
  const marketingDeps = { ...createMarketingDeps(), queue: outboundQueue };
  registerMarketingApi({
    dryRun: async (segment) => {
      const { count } = await selectSegment(marketingDeps, (segment ?? {}) as Segment);
      return { count };
    },
    schedule: async (raw) => {
      const { campaignId, reach } = await scheduleCampaign(marketingDeps, parseCampaign(raw));
      return { campaignId, reach };
    },
  });

  if (env.TELEGRAM_WEBHOOK_URL) {
    // Production: register the webhook with Telegram. Updates arrive via HTTP.
    // A failure here is fatal — without a webhook the bot receives nothing.
    // init() populates bot.botInfo (username) used to build connect links.
    await bot.init();
    const url = `${env.TELEGRAM_WEBHOOK_URL.replace(/\/$/, '')}${WEBHOOK_PATH}`;
    await bot.api.setWebhook(url);
    log.info({ url }, 'Bot running in webhook mode');
  } else {
    // Development: long polling. A Telegram error here (e.g. bad token) is
    // logged but does NOT take down the HTTP/health server.
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
      void bot.start({
        onStart: (info) =>
          log.info({ username: info.username }, 'Bot running in long-polling mode'),
      });
    } catch (err) {
      log.error({ err }, 'Bot failed to start in long-polling mode (health server still up)');
    }
  }

  // Daily-report worker (BullMQ). Requires Redis; a connection failure is
  // logged by the worker and doesn't take down the bot/health server.
  try {
    dailyReportWorker = createDailyReportWorker();
    dailyReportWorker.on('failed', (job, err) =>
      log.error({ jobId: job?.id, err }, 'Daily-report job failed'),
    );
    log.info('Daily-report worker started');
  } catch (err) {
    log.error({ err }, 'Daily-report worker failed to start (continuing)');
  }

  log.info({ env: env.NODE_ENV }, 'milele-prime-ai started');
}

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Shutting down');
  try {
    await bot.stop();
    if (dailyReportWorker) await dailyReportWorker.close();
    await closeQueues();
    await new Promise<void>((resolve) => {
      if (httpServer) httpServer.close(() => resolve());
      else resolve();
    });
  } catch (err) {
    log.error({ err }, 'Error during shutdown');
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception');
  if (!isOperationalError(err)) process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.fatal({ err: toError(reason) }, 'Unhandled rejection');
});

/** Parse a campaign from JSON, decoding base64 image/voice payloads to Buffers. */
function parseCampaign(raw: unknown): Campaign {
  const c = raw as {
    id?: unknown;
    name?: unknown;
    segment?: unknown;
    payload?: { kind?: string; body?: string; caption?: string; filename?: string; dataBase64?: string };
  };
  if (typeof c?.id !== 'string' || typeof c?.name !== 'string' || !c.payload) {
    throw new Error('campaign requires id, name, and payload');
  }
  const p = c.payload;
  let payload: MarketingPayload;
  if (p.kind === 'text') {
    if (typeof p.body !== 'string') throw new Error('text payload requires body');
    payload = { kind: 'text', body: p.body };
  } else if (p.kind === 'image' || p.kind === 'voice') {
    if (typeof p.dataBase64 !== 'string') throw new Error(`${p.kind} payload requires dataBase64`);
    const buf = Buffer.from(p.dataBase64, 'base64');
    payload =
      p.kind === 'image'
        ? { kind: 'image', image: buf, ...(p.filename ? { filename: p.filename } : {}), ...(p.caption ? { caption: p.caption } : {}) }
        : { kind: 'voice', audio: buf, ...(p.filename ? { filename: p.filename } : {}), ...(p.caption ? { caption: p.caption } : {}) };
  } else {
    throw new Error('payload.kind must be text | image | voice');
  }
  return { id: c.id, name: c.name, segment: (c.segment ?? {}) as Segment, payload };
}

start().catch((err) => {
  log.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
