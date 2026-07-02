import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  isLanguage,
  languageNative,
  normalizeLanguage,
  periodPhrase,
  t,
  type Language,
} from '../src/i18n/index.js';
import { MockMT5Connector, MockBrokeretConnector } from '../src/connectors/index.js';
import { InMemoryUserRepository } from '../src/identity/index.js';
import {
  LLMClient,
  buildDeflection,
  buildMentorSystem,
  languageDirective,
  type CompletionRequest,
  type CompletionResult,
  type LLMTransport,
} from '../src/llm/index.js';
import { computeClientMetrics, gatherMetricsInput } from '../src/metrics/index.js';
import {
  handleInbound,
  InMemoryInboundStore,
  type InboundConfig,
  type InboundDeps,
  type EscalationEvent,
  type EscalationNotifier,
} from '../src/inbound/index.js';
import type { OutboundAttachment, TelegramSender } from '../src/outbound/index.js';

// ── Language helpers ───────────────────────────────────────────────────────────
test('normalizeLanguage maps regional codes to a supported primary subtag', () => {
  assert.equal(normalizeLanguage('en-US'), 'en');
  assert.equal(normalizeLanguage('pt-BR'), 'pt');
  assert.equal(normalizeLanguage('ur'), 'ur');
  assert.equal(normalizeLanguage('AR'), 'ar');
  assert.equal(normalizeLanguage('zz'), DEFAULT_LANGUAGE, 'unknown → default');
  assert.equal(normalizeLanguage(null), DEFAULT_LANGUAGE);
  assert.equal(normalizeLanguage(undefined), DEFAULT_LANGUAGE);
});

test('isLanguage guards the supported set', () => {
  assert.ok(isLanguage('hi'));
  assert.ok(!isLanguage('zz'));
  assert.ok(!isLanguage(42));
});

test('all seven requested languages are supported', () => {
  const codes = SUPPORTED_LANGUAGES.map((l) => l.code).sort();
  assert.deepEqual(codes, ['ar', 'en', 'es', 'fr', 'hi', 'pt', 'ur'].sort());
});

// ── Catalog completeness ───────────────────────────────────────────────────────
test('every language has non-empty deterministic strings + working builders', () => {
  const sample = {
    period: 'X',
    dd: '1',
    ddPct: '2%',
    winRate: '60%',
    wins: 3,
    losses: 1,
    n: 2,
    pnl: '$10',
    openPnL: '$5',
    margin: '20%',
    best: '$9',
    worst: '-$4',
    pct: '60%',
    symbol: 'XAUUSD',
    exposure: 'x',
    recap: 'r',
    homework: 'h',
    v: '$1',
    record: '3W/1L',
    avgHold: '2h',
    from: '2025-06-19',
    to: '2025-06-25',
  };
  for (const { code } of SUPPORTED_LANGUAGES) {
    const s = t(code as Language);
    const fixed = [s.welcome, s.chooseLanguage, s.unbound, s.holding, s.throttle, s.handoff, s.cooldown, s.sttFailed, s.dataLoadFailed, s.lookupExposureNone, s.deflectionGeneric];
    for (const str of fixed) assert.ok(str.trim().length > 0, `${code}: fixed string empty`);

    const built = [
      s.languageSet('X'),
      s.accountLinked('crm-1'),
      s.lookupDrawdown(sample),
      s.lookupWinRate(sample),
      s.lookupWinRateNone(sample),
      s.lookupTradeCount(sample),
      s.lookupPnl(sample),
      s.lookupOpenPositions(sample),
      s.lookupBestTrade(sample),
      s.lookupWorstTrade(sample),
      s.lookupExposure(sample),
      s.exitV1(sample),
      s.exitV2(sample),
      s.recapMetrics(sample),
      s.deflectionExposure(sample),
      s.deflectionHistory(sample),
      s.report.title(sample),
      s.report.openRisk({ n: '1', openPnL: sample.openPnL, margin: sample.margin }),
    ];
    for (const str of built) assert.ok(str.trim().length > 0, `${code}: builder returned empty`);
  }
});

// ── LLM language directive ─────────────────────────────────────────────────────
test('language directive is empty for English and names the target language otherwise', () => {
  assert.equal(languageDirective('en'), '');
  const ar = languageDirective('ar');
  assert.match(ar, /Arabic/);
  assert.match(ar, /العربية/);
});

test('buildMentorSystem embeds the directive only for non-English', async () => {
  const metrics = await sampleMetrics();
  assert.ok(!buildMentorSystem(metrics, 'en').includes('## Language'));
  const es = buildMentorSystem(metrics, 'es');
  assert.ok(es.includes('## Language'));
  assert.match(es, /Spanish/);
  assert.match(es, /Español/);
});

// ── Storage ────────────────────────────────────────────────────────────────────
test('setLanguage persists and is returned by getByTelegramId', async () => {
  const users = new InMemoryUserRepository();
  await users.bind({ crmClientId: 'crm-1001', telegramUserId: 111, boundAt: '2025-06-01T00:00:00Z' });
  let user = await users.getByTelegramId(111);
  assert.equal(user?.language ?? null, null, 'no preference until chosen');

  await users.setLanguage('crm-1001', 'ur');
  user = await users.getByTelegramId(111);
  assert.equal(user?.language, 'ur');

  // A re-bind preserves the chosen language.
  await users.bind({ crmClientId: 'crm-1001', telegramUserId: 111, boundAt: '2025-06-02T00:00:00Z' });
  user = await users.getByTelegramId(111);
  assert.equal(user?.language, 'ur', 're-bind keeps language');
});

// ── Inbound pipeline is localized ──────────────────────────────────────────────
test('a guardrail-tripped reply is the deflection in the user language', async () => {
  const { deps, telegram } = makeDeps('ar', 'Gold will rally — you should buy now.');
  const res = await handleInbound(
    deps,
    { telegramUserId: 111, content: { type: 'text', text: 'is gold a good buy right now?' } },
    NOW,
  );
  assert.equal(res.guardrailTripped, true);
  const metrics = await sampleMetrics();
  assert.equal(res.reply, buildDeflection(metrics, 'ar'));
  assert.notEqual(res.reply, buildDeflection(metrics, 'en'), 'not the English deflection');
  assert.equal(telegram.texts.at(-1)?.text, buildDeflection(metrics, 'ar'));
});

test('the mentor call carries the language directive for the user language', async () => {
  const { deps, lastSystem } = makeDeps('ar', 'Let us focus on your own habits.');
  await handleInbound(
    deps,
    { telegramUserId: 111, content: { type: 'text', text: 'help me think about my risk please' } },
    NOW,
  );
  assert.match(lastSystem(), /العربية/, 'Arabic directive present in mentor system prompt');
});

test('the same no-LLM lookup renders differently per language', async () => {
  const ask = { type: 'text' as const, text: "what's my win rate?" };
  const en = await handleInbound(makeDeps('en').deps, { telegramUserId: 111, content: ask }, NOW);
  const es = await handleInbound(makeDeps('es').deps, { telegramUserId: 111, content: ask }, NOW);
  assert.equal(en.status, 'lookup');
  assert.equal(es.status, 'lookup');
  assert.notEqual(en.reply, es.reply, 'lookup answer is localized');

  const metrics = await sampleMetrics();
  const period = periodPhrase('es', metrics.window.granularity);
  const expected =
    metrics.numTrades > 0
      ? t('es').lookupWinRate({ period, winRate: metrics.display.winRate ?? '', wins: metrics.wins, losses: metrics.losses })
      : t('es').lookupWinRateNone({ period });
  assert.equal(es.reply, expected);
});

// ── Shared helpers ─────────────────────────────────────────────────────────────
const NOW = Date.parse('2025-06-25T09:00:00.000Z');

async function sampleMetrics() {
  const connectors = { mt5: new MockMT5Connector(), brokeret: new MockBrokeretConnector() };
  return computeClientMetrics(
    await gatherMetricsInput(connectors, {
      crmClientId: 'crm-1001',
      granularity: 'weekly',
      referenceDate: '2025-06-25',
      asOf: new Date(NOW).toISOString(),
      includePrior: true,
    }),
  );
}

class FakeTelegram implements TelegramSender {
  texts: { chatId: number; text: string }[] = [];
  async sendText(chatId: number, text: string): Promise<void> {
    this.texts.push({ chatId, text });
  }
  async sendDocument(): Promise<void> {}
  async sendPhoto(): Promise<void> {}
  async sendVoice(_chatId: number, _voice: OutboundAttachment): Promise<void> {}
}

class FakeEscalation implements EscalationNotifier {
  events: EscalationEvent[] = [];
  async notify(event: EscalationEvent): Promise<void> {
    this.events.push(event);
  }
}

function config(): InboundConfig {
  return {
    idleResetMs: 15 * 60 * 1000,
    cooldownMs: 10 * 60 * 1000,
    contextWindowExchanges: 4,
    guardrailTripEscalationThreshold: 5,
    voiceEveryN: 0,
    budget: {
      baseExchanges: 50,
      baseTokens: 10_000_000,
      tierMultipliers: { bronze: 1, silver: 1, gold: 1, platinum: 1 },
    },
  };
}

function makeDeps(
  language: Language,
  mentorReply = 'ok',
): { deps: InboundDeps; telegram: FakeTelegram; lastSystem: () => string } {
  const users = new InMemoryUserRepository();
  void users.bind({ crmClientId: 'crm-1001', telegramUserId: 111, boundAt: '2025-06-01T00:00:00Z' });
  void users.setLanguage('crm-1001', language);

  let lastSystem = '';
  const transport: LLMTransport = {
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      if (req.system.includes('compliance classifier')) {
        return { text: '{"forbidden":false}', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (req.system.includes('running summary')) {
        return { text: 'summary', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      }
      lastSystem = req.system;
      return { text: mentorReply, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20 } };
    },
    async countTokens() {
      return 1;
    },
  };
  const llm = new LLMClient({ transport, mentorModel: 'm', classifierModel: 'c', mentorMaxTokens: 1024 });
  const telegram = new FakeTelegram();
  const deps: InboundDeps = {
    connectors: { mt5: new MockMT5Connector(), brokeret: new MockBrokeretConnector() },
    llm,
    store: new InMemoryInboundStore(),
    users,
    telegram,
    escalation: new FakeEscalation(),
    classifier: (text: string) => llm.classifyOutbound(text),
    config: config(),
    clock: { now: () => NOW },
  };
  return { deps, telegram, lastSystem: () => lastSystem };
}
