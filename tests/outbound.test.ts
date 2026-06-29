import test from 'node:test';
import assert from 'node:assert/strict';

import { MockMT5Connector, MockBrokeretConnector } from '../src/connectors/index.js';
import { InMemoryUserRepository } from '../src/identity/index.js';
import { LLMClient, buildDeterministicReport, type CompletionResult } from '../src/llm/index.js';
import { computeClientMetrics, gatherMetricsInput } from '../src/metrics/index.js';
import {
  processDailyReport,
  scheduleDailyReports,
  buildDailyReportPdf,
  InMemoryOutboundStore,
  type DailyReportConfig,
  type DailyReportDeps,
  type QueueLike,
  type TelegramSender,
  type TtsClient,
  type OutboundAttachment,
} from '../src/outbound/index.js';

// ── Fakes ────────────────────────────────────────────────────────────────────
class FakeTelegram implements TelegramSender {
  texts: { chatId: number; text: string }[] = [];
  docs: { chatId: number; doc: OutboundAttachment; caption?: string }[] = [];
  voices: { chatId: number; voice: OutboundAttachment; caption?: string }[] = [];
  async sendText(chatId: number, text: string): Promise<void> {
    this.texts.push({ chatId, text });
  }
  async sendDocument(chatId: number, doc: OutboundAttachment, caption?: string): Promise<void> {
    this.docs.push({ chatId, doc, ...(caption !== undefined ? { caption } : {}) });
  }
  async sendPhoto(): Promise<void> {}
  async sendVoice(chatId: number, voice: OutboundAttachment, caption?: string): Promise<void> {
    this.voices.push({ chatId, voice, ...(caption !== undefined ? { caption } : {}) });
  }
}

class FakeTts implements TtsClient {
  synthesized: string[] = [];
  async synthesize(text: string): Promise<{ audio: Buffer; format: string; charCount: number }> {
    this.synthesized.push(text);
    return { audio: Buffer.from('OggS-fake-opus'), format: 'ogg-opus', charCount: text.length };
  }
}

class FakeQueue implements QueueLike {
  jobs = new Map<string, { name: string; data: unknown; opts: { delay?: number; jobId?: string } }>();
  async add(name: string, data: unknown, opts: { delay?: number; jobId?: string }): Promise<unknown> {
    const id = opts.jobId ?? String(this.jobs.size);
    if (this.jobs.has(id)) return { id, deduped: true };
    this.jobs.set(id, { name, data, opts });
    return { id };
  }
}

const SAFE_NARRATIVE =
  'Good morning. Here is your trading summary for the period — the focus, as always, is your own discipline and the habits behind these numbers. Keep reviewing what worked and what did not.';

function makeLLM(text: string): LLMClient {
  const responder = (): CompletionResult => ({
    text,
    stopReason: 'end_turn',
    usage: { inputTokens: 12, outputTokens: 48 },
  });
  return new LLMClient({
    transport: { async complete() { return responder(); }, async countTokens() { return 1; } },
    mentorModel: 'm',
    classifierModel: 'c',
    mentorMaxTokens: 1024,
  });
}

const CONFIG: DailyReportConfig = {
  voiceEnabled: false,
  reportGranularity: 'weekly',
  reportHourLocal: 7,
  brandName: 'Milele Prime',
};

const NOW = Date.parse('2025-06-25T05:00:00.000Z');
const REPORT_DATE = '2025-06-25';

function boundRepo(crmIds: ReadonlyArray<[string, number]>): InMemoryUserRepository {
  const repo = new InMemoryUserRepository();
  for (const [crmClientId, telegramUserId] of crmIds) {
    void repo.bind({ crmClientId, telegramUserId, boundAt: '2025-06-01T00:00:00Z' });
  }
  return repo;
}

const COHORT: ReadonlyArray<[string, number]> = [
  ['crm-1001', 111],
  ['crm-1002', 112],
  ['crm-1003', 113],
  ['crm-1005', 115],
];

function makeDeps(overrides: Partial<DailyReportDeps> = {}): DailyReportDeps {
  return {
    connectors: { mt5: new MockMT5Connector(), brokeret: new MockBrokeretConnector() },
    llm: makeLLM(SAFE_NARRATIVE),
    store: new InMemoryOutboundStore(),
    users: boundRepo(COHORT),
    telegram: new FakeTelegram(),
    config: CONFIG,
    clock: { now: () => NOW },
    ...overrides,
  };
}

// ── 4a — scheduling at local morning ─────────────────────────────────────────
test('schedules each consented+bound client at ~7am their local time', async () => {
  const queue = new FakeQueue();
  const deps = {
    connectors: { mt5: new MockMT5Connector(), brokeret: new MockBrokeretConnector() },
    users: boundRepo(COHORT),
    queue,
    config: CONFIG,
  };

  const scheduled = await scheduleDailyReports(deps, NOW);
  // crm-1004 is inactive (KYC pending) and excluded; the other 4 are scheduled.
  assert.equal(scheduled.length, 4);
  assert.ok(!scheduled.some((s) => s.crmClientId === 'crm-1004'));

  for (const s of scheduled) {
    const client = await deps.connectors.brokeret.getClient(s.crmClientId);
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone: client.timezone,
      hourCycle: 'h23',
      hour: '2-digit',
    }).format(new Date(s.fireAtMs));
    assert.equal(Number(hour), 7, `${s.crmClientId} fires at 07:00 local`);
    assert.ok(s.delayMs >= 0 && s.fireAtMs > NOW);
  }

  // Re-running the scheduler does not double-enqueue (deterministic jobId).
  await scheduleDailyReports(deps, NOW);
  assert.equal(queue.jobs.size, 4);
});

// ── 4a — text report per client ──────────────────────────────────────────────
test('each fixture client gets a personalized text report, logged', async () => {
  for (const [crmClientId, chatId] of COHORT) {
    const telegram = new FakeTelegram();
    const store = new InMemoryOutboundStore();
    const deps = makeDeps({ telegram, store });

    const res = await processDailyReport(deps, { crmClientId, reportDate: REPORT_DATE });
    assert.equal(res.status, 'sent');
    assert.equal(res.guardrailTripped, false);
    assert.equal(res.hasPdf, false);
    assert.equal(res.voiced, false);

    // Sent to the right chat, exactly once, with the narrative text.
    assert.equal(telegram.texts.length, 1);
    assert.equal(telegram.texts[0]?.chatId, chatId);
    assert.equal(telegram.texts[0]?.text, SAFE_NARRATIVE);

    // Metrics persisted for this client+date.
    assert.ok(store.dailyMetrics.has(`${crmClientId}:${REPORT_DATE}`));

    // outbound_log marked sent; message logged.
    const log = store.logs.find((l) => l.crmClientId === crmClientId);
    assert.equal(log?.status, 'sent');
    assert.ok(log?.sentAt);
    assert.equal(store.messages.length, 1);
    assert.equal(store.messages[0]?.content, SAFE_NARRATIVE);
    assert.equal(store.messages[0]?.direction, 'out');
  }
});

// ── 4a — idempotency ─────────────────────────────────────────────────────────
test('never double-sends for the same client+date', async () => {
  const telegram = new FakeTelegram();
  const store = new InMemoryOutboundStore();
  const deps = makeDeps({ telegram, store });

  const first = await processDailyReport(deps, { crmClientId: 'crm-1001', reportDate: REPORT_DATE });
  const second = await processDailyReport(deps, { crmClientId: 'crm-1001', reportDate: REPORT_DATE });

  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'skipped');
  assert.equal(telegram.texts.length, 1, 'text sent only once');
});

// ── 4a — guardrail trips → deterministic template ────────────────────────────
test('guardrail trip falls back to a deterministic template (no LLM numbers)', async () => {
  const telegram = new FakeTelegram();
  const store = new InMemoryOutboundStore();
  const users = boundRepo(COHORT);
  const deps = makeDeps({
    telegram,
    store,
    users,
    llm: makeLLM('Gold will rally hard next week — you should buy now while it is cheap.'),
  });

  const res = await processDailyReport(deps, { crmClientId: 'crm-1001', reportDate: REPORT_DATE });
  assert.equal(res.status, 'sent');
  assert.equal(res.guardrailTripped, true);

  // Build the expected template from the same metrics.
  const input = await gatherMetricsInput(deps.connectors, {
    crmClientId: 'crm-1001',
    granularity: 'weekly',
    referenceDate: REPORT_DATE,
    asOf: `${REPORT_DATE}T07:00:00.000Z`,
    includePrior: true,
  });
  const template = buildDeterministicReport(computeClientMetrics(input));

  assert.equal(telegram.texts[0]?.text, template, 'sent the deterministic template, not the forbidden text');
  assert.ok(!telegram.texts[0]?.text.includes('rally'), 'forbidden content never sent');
  // The trip was audited.
  assert.ok(users.audits.some((a) => a.eventType === 'guardrail_trip'));
});

// ── 4b — the daily drop includes a branded PDF (from metrics) ────────────────
test('daily drop attaches a correct, on-brand PDF alongside the text', async () => {
  for (const [crmClientId, chatId] of COHORT) {
    const telegram = new FakeTelegram();
    const deps = makeDeps({ telegram, pdf: buildDailyReportPdf });

    const res = await processDailyReport(deps, { crmClientId, reportDate: REPORT_DATE });
    assert.equal(res.status, 'sent');
    assert.equal(res.hasPdf, true);

    // Text + PDF both delivered, to the right chat.
    assert.equal(telegram.texts.length, 1);
    assert.equal(telegram.docs.length, 1);
    const doc = telegram.docs[0];
    assert.equal(doc?.chatId, chatId);
    assert.equal(doc?.doc.filename, `milele-${REPORT_DATE}.pdf`);

    // A real, non-trivial PDF.
    const buf = doc?.doc.buffer;
    assert.ok(buf && buf.length > 1000, 'PDF has real content');
    assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-', 'valid PDF header');
    assert.equal(buf.subarray(-6).toString('latin1').trim(), '%%EOF', 'valid PDF trailer');
  }
});

test('PDF builds from metrics for every fixture persona (incl. zero-trades)', async () => {
  const brokeret = new MockBrokeretConnector();
  const mt5 = new MockMT5Connector();
  for (const crmClientId of ['crm-1001', 'crm-1002', 'crm-1003', 'crm-1004', 'crm-1005']) {
    const client = await brokeret.getClient(crmClientId);
    const input = await gatherMetricsInput(
      { mt5, brokeret },
      { crmClientId, granularity: 'weekly', referenceDate: REPORT_DATE, includePrior: true },
    );
    const buf = await buildDailyReportPdf(computeClientMetrics(input), client);
    assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-', `valid PDF for ${crmClientId}`);
  }
});

// ── 4c — the daily drop includes a native voice note (from the TEXT) ─────────
test('daily drop arrives as text + PDF + voice; voice matches the text narrative', async () => {
  const telegram = new FakeTelegram();
  const store = new InMemoryOutboundStore();
  const tts = new FakeTts();
  const deps = makeDeps({
    telegram,
    store,
    tts,
    pdf: buildDailyReportPdf,
    config: { ...CONFIG, voiceEnabled: true },
  });

  const res = await processDailyReport(deps, { crmClientId: 'crm-1001', reportDate: REPORT_DATE });
  assert.equal(res.status, 'sent');

  // All three siblings delivered.
  assert.equal(telegram.texts.length, 1);
  assert.equal(telegram.docs.length, 1);
  assert.equal(telegram.voices.length, 1);

  // Native voice note: OGG/Opus filename so Telegram renders it as a voice note.
  const voice = telegram.voices[0];
  assert.equal(voice?.voice.filename, 'milele-note.ogg');

  // The voice is TTS of the narrative TEXT — not the PDF.
  assert.equal(tts.synthesized.length, 1);
  assert.equal(tts.synthesized[0], SAFE_NARRATIVE, 'voice synthesized from the text narrative');
  assert.equal(telegram.texts[0]?.text, SAFE_NARRATIVE);

  // Logged: voiced flag + TTS character count for cost tracking.
  assert.equal(res.voiced, true);
  assert.equal(res.ttsCharCount, SAFE_NARRATIVE.length);
  const log = store.logs.find((l) => l.crmClientId === 'crm-1001');
  assert.equal(log?.voiced, true);
  assert.equal(log?.ttsCharCount, SAFE_NARRATIVE.length);
});

test('voicing is a tunable flag — off means no voice note', async () => {
  const telegram = new FakeTelegram();
  const tts = new FakeTts();
  const deps = makeDeps({ telegram, tts, config: { ...CONFIG, voiceEnabled: false } });

  const res = await processDailyReport(deps, { crmClientId: 'crm-1001', reportDate: REPORT_DATE });
  assert.equal(res.voiced, false);
  assert.equal(telegram.voices.length, 0);
  assert.equal(tts.synthesized.length, 0);
});

test('on a guardrail trip, the voice matches the template that was actually sent', async () => {
  const telegram = new FakeTelegram();
  const tts = new FakeTts();
  const deps = makeDeps({
    telegram,
    tts,
    config: { ...CONFIG, voiceEnabled: true },
    llm: makeLLM('XAUUSD looks strong — you should buy now.'),
  });

  await processDailyReport(deps, { crmClientId: 'crm-1001', reportDate: REPORT_DATE });
  // Voice never carries the forbidden text; it matches the sent (template) text.
  assert.equal(tts.synthesized[0], telegram.texts[0]?.text);
  assert.ok(!tts.synthesized[0]?.includes('looks strong'));
});

// ── 4a — consent + binding guards ────────────────────────────────────────────
test('skips clients without consent or without a bound Telegram account', async () => {
  // crm-1004 has consent_ai_messaging = false.
  const noConsent = await processDailyReport(
    makeDeps({ users: boundRepo([['crm-1004', 114]]) }),
    { crmClientId: 'crm-1004', reportDate: REPORT_DATE },
  );
  assert.equal(noConsent.status, 'no_consent');

  // Consented client with no binding.
  const unbound = await processDailyReport(
    makeDeps({ users: new InMemoryUserRepository() }),
    { crmClientId: 'crm-1001', reportDate: REPORT_DATE },
  );
  assert.equal(unbound.status, 'unbound');
});
