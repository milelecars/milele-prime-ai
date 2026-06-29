import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { env } from '../src/config/env.js';
import { MockBrokeretConnector } from '../src/connectors/index.js';
import {
  signConnectToken,
  verifyConnectToken,
  generateConnectLink,
  bindTelegramUser,
  BindEvent,
  requireBoundUser,
  UNBOUND_MESSAGE,
  InMemoryUserRepository,
} from '../src/identity/index.js';
import type { BotContext } from '../src/bot/context.js';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../src/lib/errors.js';
import { createHttpServer, CONNECT_LINK_PATH } from '../src/server.js';

const brokeret = new MockBrokeretConnector();
const deps = (repo: InMemoryUserRepository) => ({ repo, brokeret });

// ── Token ────────────────────────────────────────────────────────────────────
test('connect token: sign → verify round-trip; Telegram-safe', () => {
  const { token } = signConnectToken('crm-1001');
  assert.ok(token.length <= 64, 'token fits Telegram 64-char limit');
  assert.match(token, /^[A-Za-z0-9_-]+$/, 'token uses only deep-link-safe chars');
  assert.equal(verifyConnectToken(token).crmClientId, 'crm-1001');
});

test('connect token: expired token rejected', () => {
  const t0 = 1_700_000_000_000;
  const { token } = signConnectToken('crm-1001', { now: t0, ttlMs: 1_000 });
  assert.equal(verifyConnectToken(token, { now: t0 }).crmClientId, 'crm-1001');
  assert.throws(() => verifyConnectToken(token, { now: t0 + 2_000 }), AuthorizationError);
});

test('connect token: tampered token rejected', () => {
  const { token } = signConnectToken('crm-1001');
  // Flip the last char of the signature.
  const last = token.slice(-1);
  const tampered = token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
  assert.throws(() => verifyConnectToken(tampered), AuthorizationError);
  // Malformed input.
  assert.throws(() => verifyConnectToken('not.a.token'), ValidationError);
  assert.throws(() => verifyConnectToken(''), ValidationError);
});

// ── Binding ──────────────────────────────────────────────────────────────────
test('bind: valid token binds and persists with consent + audit', async () => {
  const repo = new InMemoryUserRepository();
  const { token } = signConnectToken('crm-1001');

  const result = await bindTelegramUser(deps(repo), { token, telegramUserId: 111 });
  assert.equal(result.status, 'bound');
  assert.equal(result.crmClientId, 'crm-1001');

  const stored = await repo.getByCrmId('crm-1001');
  assert.equal(stored?.telegramUserId, 111);
  assert.equal(stored?.consentAiMessaging, true);
  assert.ok(stored?.boundAt, 'bound_at persisted');

  assert.equal(await (await repo.getByTelegramId(111))?.crmClientId, 'crm-1001');
  assert.ok(repo.audits.some((a) => a.eventType === BindEvent.BOUND));
});

test('bind: re-binding the same Telegram↔CRM pair is idempotent', async () => {
  const repo = new InMemoryUserRepository();
  const { token } = signConnectToken('crm-1001');

  const first = await bindTelegramUser(deps(repo), { token, telegramUserId: 111 });
  const second = await bindTelegramUser(deps(repo), { token, telegramUserId: 111 });
  assert.equal(first.status, 'bound');
  assert.equal(second.status, 'already_bound');
  assert.ok(repo.audits.some((a) => a.eventType === BindEvent.REBIND_NOOP));
});

test('bind: Telegram ID already bound to a different CRM is rejected', async () => {
  const repo = new InMemoryUserRepository();
  await bindTelegramUser(deps(repo), { token: signConnectToken('crm-1001').token, telegramUserId: 111 });

  // Same Telegram ID, different client.
  const other = signConnectToken('crm-1002').token;
  await assert.rejects(
    () => bindTelegramUser(deps(repo), { token: other, telegramUserId: 111 }),
    ConflictError,
  );
  assert.ok(repo.audits.some((a) => a.eventType === BindEvent.CONFLICT_TELEGRAM));
});

test('bind: CRM client already bound to a different Telegram ID is rejected', async () => {
  const repo = new InMemoryUserRepository();
  await bindTelegramUser(deps(repo), { token: signConnectToken('crm-1001').token, telegramUserId: 111 });

  // Same client, different Telegram ID.
  await assert.rejects(
    () => bindTelegramUser(deps(repo), { token: signConnectToken('crm-1001').token, telegramUserId: 222 }),
    ConflictError,
  );
  assert.ok(repo.audits.some((a) => a.eventType === BindEvent.CONFLICT_CRM));
});

test('bind: unknown CRM client is rejected and audited', async () => {
  const repo = new InMemoryUserRepository();
  const { token } = signConnectToken('crm-9999'); // not a fixture
  await assert.rejects(
    () => bindTelegramUser(deps(repo), { token, telegramUserId: 111 }),
    NotFoundError,
  );
  assert.ok(repo.audits.some((a) => a.eventType === BindEvent.CLIENT_MISSING));
});

test('bind: expired token rejected and audited', async () => {
  const repo = new InMemoryUserRepository();
  const t0 = 1_700_000_000_000;
  const { token } = signConnectToken('crm-1001', { now: t0, ttlMs: 1_000 });
  await assert.rejects(
    () => bindTelegramUser(deps(repo), { token, telegramUserId: 111, now: t0 + 5_000 }),
    AuthorizationError,
  );
  assert.ok(repo.audits.some((a) => a.eventType === BindEvent.TOKEN_REJECTED));
});

// ── Middleware ───────────────────────────────────────────────────────────────
function fakeCtx(fromId: number | undefined): { ctx: BotContext; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    from: fromId === undefined ? undefined : { id: fromId },
    reply: async (text: string) => {
      replies.push(text);
    },
  } as unknown as BotContext;
  return { ctx, replies };
}

test('middleware: unbound user is refused, never reaches handler', async () => {
  const repo = new InMemoryUserRepository();
  const mw = requireBoundUser(repo);
  const { ctx, replies } = fakeCtx(999);
  let reached = false;
  await mw(ctx, async () => {
    reached = true;
  });
  assert.equal(reached, false);
  assert.deepEqual(replies, [UNBOUND_MESSAGE]);
  assert.equal(ctx.boundUser, undefined);
});

test('middleware: bound user passes and ctx.boundUser is populated', async () => {
  const repo = new InMemoryUserRepository();
  await bindTelegramUser(deps(repo), { token: signConnectToken('crm-1001').token, telegramUserId: 111 });
  const mw = requireBoundUser(repo);
  const { ctx, replies } = fakeCtx(111);
  let reached = false;
  await mw(ctx, async () => {
    reached = true;
  });
  assert.equal(reached, true);
  assert.equal(replies.length, 0);
  assert.equal(ctx.boundUser?.crmClientId, 'crm-1001');
});

// ── Internal link-minting endpoint ───────────────────────────────────────────
test('connect-link endpoint: auth + minting', async () => {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}${CONNECT_LINK_PATH}`;
  const body = JSON.stringify({ crmClientId: 'crm-1001' });

  try {
    // Missing secret → 401.
    const noSecret = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(noSecret.status, 401);

    // Wrong secret → 401.
    const wrong = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-crm-secret': 'nope' },
      body,
    });
    assert.equal(wrong.status, 401);

    // Correct secret → 200 + valid deep link.
    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-crm-secret': env.CRM_SHARED_SECRET },
      body,
    });
    assert.equal(ok.status, 200);
    const payload = (await ok.json()) as { link: string; token: string; expiresAt: string };
    assert.match(payload.link, /^https:\/\/t\.me\/milele_prime_bot\?start=/);
    assert.equal(verifyConnectToken(payload.token).crmClientId, 'crm-1001');

    // Missing crmClientId → 400.
    const bad = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-crm-secret': env.CRM_SHARED_SECRET },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);

    // Generated link binds an end-to-end fake Telegram user.
    const repo = new InMemoryUserRepository();
    const { token } = generateConnectLink('crm-1001', { botUsername: 'milele_prime_bot' });
    const bound = await bindTelegramUser(deps(repo), { token, telegramUserId: 777 });
    assert.equal(bound.status, 'bound');
    assert.equal((await repo.getByTelegramId(777))?.crmClientId, 'crm-1001');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
