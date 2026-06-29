import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { env } from './config/env.js';
import { childLogger } from './lib/logger.js';
import { handleWebhook, WEBHOOK_PATH } from './bot/webhook.js';
import { getBotUsername } from './bot/bot.js';
import { generateConnectLink } from './identity/index.js';
import { ValidationError } from './lib/errors.js';

const log = childLogger('server');

const useWebhook = Boolean(env.TELEGRAM_WEBHOOK_URL);

/** Path the Brokeret CRM calls (authenticated) to mint connect links. */
export const CONNECT_LINK_PATH = '/internal/connect-link';
export const MARKETING_DRYRUN_PATH = '/internal/marketing/dry-run';
export const MARKETING_CAMPAIGN_PATH = '/internal/marketing/campaign';

/**
 * Injected marketing admin API (avoids importing the queue into this module,
 * which would eagerly connect to Redis). Wired at startup by `index.ts`.
 */
export interface MarketingApi {
  dryRun(segment: unknown): Promise<{ count: number }>;
  schedule(campaign: unknown): Promise<{ campaignId: string; reach: number }>;
}
let marketingApi: MarketingApi | undefined;
export function registerMarketingApi(api: MarketingApi): void {
  marketingApi = api;
}

export const HALT_PATH = '/internal/halt';

/** Injected kill-switch control (wired at startup; no Redis import here). */
export interface HaltControl {
  get(): Promise<boolean>;
  set(halted: boolean): Promise<void>;
}
let haltControl: HaltControl | undefined;
export function registerHaltControl(control: HaltControl): void {
  haltControl = control;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Constant-time string comparison that is safe for unequal lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function readJsonBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new ValidationError('Request body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
}

/**
 * Handle the authenticated connect-link minting request. The CRM proves its
 * identity with the shared secret; on success the server issues a signed,
 * short-lived deep link.
 */
async function handleConnectLink(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const provided = req.headers['x-crm-secret'];
  if (typeof provided !== 'string' || !safeEqual(provided, env.CRM_SHARED_SECRET)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : 'bad request' });
    return;
  }

  const crmClientId = (body as { crmClientId?: unknown })?.crmClientId;
  if (typeof crmClientId !== 'string' || crmClientId.trim() === '') {
    sendJson(res, 400, { error: 'crmClientId is required' });
    return;
  }

  const botUsername = getBotUsername();
  if (!botUsername) {
    log.error('Cannot mint connect link: bot username unavailable');
    sendJson(res, 503, { error: 'bot username unavailable' });
    return;
  }

  try {
    const result = generateConnectLink(crmClientId.trim(), {
      botUsername,
      ttlMs: env.CONNECT_LINK_TTL_MS,
    });
    sendJson(res, 200, result);
  } catch (err) {
    log.error({ err }, 'Failed to generate connect link');
    sendJson(res, 400, { error: err instanceof Error ? err.message : 'failed to mint link' });
  }
}

/** Authenticated marketing admin endpoints (dry-run + schedule). */
async function handleMarketing(
  req: IncomingMessage,
  res: ServerResponse,
  kind: 'dry-run' | 'campaign',
): Promise<void> {
  const provided = req.headers['x-crm-secret'];
  if (typeof provided !== 'string' || !safeEqual(provided, env.CRM_SHARED_SECRET)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  if (!marketingApi) {
    sendJson(res, 503, { error: 'marketing api unavailable' });
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : 'bad request' });
    return;
  }
  try {
    if (kind === 'dry-run') {
      const segment = (body as { segment?: unknown })?.segment ?? {};
      sendJson(res, 200, await marketingApi.dryRun(segment));
    } else {
      const campaign = (body as { campaign?: unknown })?.campaign;
      if (campaign === undefined) {
        sendJson(res, 400, { error: 'campaign is required' });
        return;
      }
      sendJson(res, 200, await marketingApi.schedule(campaign));
    }
  } catch (err) {
    log.error({ err }, 'Marketing endpoint failed');
    sendJson(res, 400, { error: err instanceof Error ? err.message : 'failed' });
  }
}

async function requestListener(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';

  if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
    sendJson(res, 200, { status: 'ok', service: 'milele-prime-ai', uptime: process.uptime() });
    return;
  }

  if (req.method === 'POST' && url === CONNECT_LINK_PATH) {
    await handleConnectLink(req, res);
    return;
  }

  // Kill switch — GET reads, POST {halted:bool} flips.
  if (url === HALT_PATH && (req.method === 'GET' || req.method === 'POST')) {
    const provided = req.headers['x-crm-secret'];
    if (typeof provided !== 'string' || !safeEqual(provided, env.CRM_SHARED_SECRET)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (!haltControl) {
      sendJson(res, 503, { error: 'halt control unavailable' });
      return;
    }
    try {
      if (req.method === 'POST') {
        const body = (await readJsonBody(req).catch(() => ({}))) as { halted?: unknown };
        await haltControl.set(Boolean(body?.halted));
      }
      sendJson(res, 200, { halted: await haltControl.get() });
    } catch (err) {
      log.error({ err }, 'Halt control failed');
      sendJson(res, 503, { error: 'halt control failed' });
    }
    return;
  }

  if (req.method === 'POST' && url === MARKETING_DRYRUN_PATH) {
    await handleMarketing(req, res, 'dry-run');
    return;
  }

  if (req.method === 'POST' && url === MARKETING_CAMPAIGN_PATH) {
    await handleMarketing(req, res, 'campaign');
    return;
  }

  if (useWebhook && req.method === 'POST' && url === WEBHOOK_PATH) {
    try {
      await handleWebhook(req, res);
    } catch (err) {
      log.error({ err }, 'Webhook handler failed');
      if (!res.headersSent) sendJson(res, 500, { status: 'error' });
    }
    return;
  }

  sendJson(res, 404, { status: 'not_found' });
}

/** Create (but do not start) the HTTP server. */
export function createHttpServer(): Server {
  return createServer((req, res) => {
    void requestListener(req, res);
  });
}

/** Start the HTTP server on the configured port. */
export function startHttpServer(): Promise<Server> {
  const server = createHttpServer();
  return new Promise((resolve) => {
    server.listen(env.PORT, () => {
      log.info({ port: env.PORT, webhook: useWebhook }, 'HTTP server listening');
      resolve(server);
    });
  });
}
