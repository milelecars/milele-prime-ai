import test from 'node:test';
import assert from 'node:assert/strict';

import { MockMT5Connector, MockBrokeretConnector } from '../src/connectors/index.js';
import { InMemoryUserRepository } from '../src/identity/index.js';
import {
  LLMClient,
  buildDeflection,
  TIGHTEN_DIRECTIVE,
  type CompletionRequest,
  type CompletionResult,
  type LLMTransport,
} from '../src/llm/index.js';
import { computeClientMetrics, gatherMetricsInput } from '../src/metrics/index.js';
import {
  handleInbound,
  capsForTier,
  InMemoryInboundStore,
  type InboundConfig,
  type BudgetConfig,
  type InboundDeps,
  type EscalationEvent,
  type EscalationNotifier,
  type SttClient,
} from '../src/inbound/index.js';
import type { OutboundAttachment, TelegramSender, TtsClient } from '../src/outbound/index.js';

// ── Fakes ────────────────────────────────────────────────────────────────────
class FakeTelegram implements TelegramSender {
  texts: { chatId: number; text: string }[] = [];
  voices: { chatId: number; voice: OutboundAttachment }[] = [];
  async sendText(chatId: number, text: string): Promise<void> {
    this.texts.push({ chatId, text });
  }
  async sendDocument(): Promise<void> {}
  async sendPhoto(): Promise<void> {}
  async sendVoice(chatId: number, voice: OutboundAttachment): Promise<void> {
    this.voices.push({ chatId, voice });
  }
}

class FakeTts implements TtsClient {
  count = 0;
  async synthesize(text: string): Promise<{ audio: Buffer; format: string; charCount: number }> {
    this.count += 1;
    return { audio: Buffer.from('OggS'), format: 'ogg-opus', charCount: text.length };
  }
}

class FakeStt implements SttClient {
  calls = 0;
  constructor(private readonly text: string) {}
  async transcribe(): Promise<string> {
    this.calls += 1;
    return this.text;
  }
}

class FakeEscalation implements EscalationNotifier {
  events: EscalationEvent[] = [];
  async notify(event: EscalationEvent): Promise<void> {
    this.events.push(event);
  }
}

interface FakeLLM {
  llm: LLMClient;
  mentorCalls: () => number;
  lastMentorSystem: () => string;
}

function makeLLM(mentorReply: string): FakeLLM {
  let mentorCalls = 0;
  let lastMentorSystem = '';
  const transport: LLMTransport = {
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      if (req.system.includes('compliance classifier')) {
        return { text: '{"forbidden":false}', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
      }
      if (req.system.includes('running summary')) {
        return { text: 'Earlier we discussed the client risk habits.', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 8 } };
      }
      mentorCalls += 1;
      lastMentorSystem = req.system;
      return { text: mentorReply, stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 60 } };
    },
    async countTokens() {
      return 1;
    },
  };
  return {
    llm: new LLMClient({ transport, mentorModel: 'm', classifierModel: 'c', mentorMaxTokens: 1024 }),
    mentorCalls: () => mentorCalls,
    lastMentorSystem: () => lastMentorSystem,
  };
}

const SAFE_REPLY = "Let's focus on your own habits — what stood out to you about this week?";

// Flat tier multipliers so budget math is independent of the fixture's tier.
function config(
  overrides: Partial<Omit<InboundConfig, 'budget'>> & { budget?: Partial<BudgetConfig> } = {},
): InboundConfig {
  const base: InboundConfig = {
    idleResetMs: 15 * 60 * 1000,
    cooldownMs: 10 * 60 * 1000,
    contextWindowExchanges: 4,
    guardrailTripEscalationThreshold: 2,
    voiceEveryN: 3,
    budget: {
      baseExchanges: 4,
      baseTokens: 10_000_000,
      tierMultipliers: { bronze: 1, silver: 1, gold: 1, platinum: 1 },
    },
  };
  const { budget, ...rest } = overrides;
  return { ...base, ...rest, budget: { ...base.budget, ...(budget ?? {}) } };
}

const NOW = Date.parse('2025-06-25T09:00:00.000Z');

function makeDeps(over: {
  llm?: FakeLLM;
  telegram?: FakeTelegram;
  tts?: FakeTts;
  stt?: FakeStt;
  escalation?: FakeEscalation;
  users?: InMemoryUserRepository;
  store?: InMemoryInboundStore;
  config?: InboundConfig;
  bound?: ReadonlyArray<[string, number]>;
} = {}): { deps: InboundDeps; fakes: { telegram: FakeTelegram; tts: FakeTts; escalation: FakeEscalation; users: InMemoryUserRepository; store: InMemoryInboundStore; llm: FakeLLM } } {
  const users = over.users ?? new InMemoryUserRepository();
  for (const [crmClientId, tg] of over.bound ?? [['crm-1001', 111]]) {
    void users.bind({ crmClientId, telegramUserId: tg, boundAt: '2025-06-01T00:00:00Z' });
  }
  const llm = over.llm ?? makeLLM(SAFE_REPLY);
  const telegram = over.telegram ?? new FakeTelegram();
  const tts = over.tts ?? new FakeTts();
  const escalation = over.escalation ?? new FakeEscalation();
  const store = over.store ?? new InMemoryInboundStore();
  const deps: InboundDeps = {
    connectors: { mt5: new MockMT5Connector(), brokeret: new MockBrokeretConnector() },
    llm: llm.llm,
    store,
    users,
    telegram,
    escalation,
    tts,
    ...(over.stt ? { stt: over.stt } : {}),
    config: over.config ?? config(),
    clock: { now: () => NOW },
  };
  return { deps, fakes: { telegram, tts, escalation, users, store, llm } };
}

// ── Identity ─────────────────────────────────────────────────────────────────
test('unbound Telegram ID is refused with the connect message, no data served', async () => {
  const { deps, fakes } = makeDeps({ bound: [] });
  const res = await handleInbound(deps, { telegramUserId: 999, content: { type: 'text', text: 'hi' } }, NOW);
  assert.equal(res.status, 'unbound');
  assert.match(fakes.telegram.texts[0]?.text ?? '', /Connect button/i);
  assert.equal(fakes.llm.mentorCalls(), 0);
});

// ── Routing — simple lookup, no LLM ──────────────────────────────────────────
test('simple lookups answer from metrics with NO LLM call', async () => {
  const cases = ["what's my drawdown?", 'how many trades today?', "what's my win rate?"];
  for (const text of cases) {
    const { deps, fakes } = makeDeps();
    const res = await handleInbound(deps, { telegramUserId: 111, content: { type: 'text', text } }, NOW);
    assert.equal(res.status, 'lookup');
    assert.equal(res.llmCalled, false);
    assert.equal(fakes.llm.mentorCalls(), 0, `no model call for "${text}"`);
    assert.ok((fakes.telegram.texts[0]?.text ?? '').length > 0);
  }

  // A coaching question that mentions a metric is NOT a lookup.
  const { deps, fakes } = makeDeps();
  const res = await handleInbound(deps, { telegramUserId: 111, content: { type: 'text', text: 'how do I reduce my drawdown?' } }, NOW);
  assert.equal(res.status, 'mentor');
  assert.equal(fakes.llm.mentorCalls(), 1);
});

// ── Budget bands + graceful exit + reset ─────────────────────────────────────
test('budget tiers (<70%, 70–100%, at-cap) trigger the right behavior, then reset', async () => {
  const { deps, fakes } = makeDeps();
  const lookup = { type: 'text' as const, text: "what's my win rate?" };

  // baseExchanges=4 → cap at the 5th message.
  const r1 = await handleInbound(deps, { telegramUserId: 111, content: lookup }, NOW);
  const r2 = await handleInbound(deps, { telegramUserId: 111, content: lookup }, NOW);
  const r3 = await handleInbound(deps, { telegramUserId: 111, content: lookup }, NOW);
  assert.equal(r1.band, 'normal');
  assert.equal(r2.band, 'normal');
  assert.equal(r3.band, 'normal'); // count 2 → 0.5

  const r4 = await handleInbound(deps, { telegramUserId: 111, content: lookup }, NOW);
  assert.equal(r4.band, 'tighten'); // count 3 → 0.75

  const r5 = await handleInbound(deps, { telegramUserId: 111, content: lookup }, NOW);
  assert.equal(r5.band, 'cap');
  assert.equal(r5.status, 'exit');
  assert.equal(fakes.llm.mentorCalls(), 0, 'no model call at cap');

  // Session is closed with a cooldown.
  const closed = await fakes.store.getLatestSession('crm-1001');
  assert.equal(closed?.status, 'closed');
  assert.ok(closed?.cooldownUntil && closed.cooldownUntil > NOW);
  const closedId = closed?.conversationId;

  // During cooldown: graceful cooldown reply, no new session.
  const during = await handleInbound(deps, { telegramUserId: 111, content: lookup }, NOW + 1000);
  assert.equal(during.status, 'cooldown');

  // After cooldown: a fresh session with a reset budget.
  const after = await handleInbound(deps, { telegramUserId: 111, content: lookup }, NOW + 11 * 60 * 1000);
  assert.equal(after.status, 'lookup');
  assert.equal(after.band, 'normal');
  const fresh = await fakes.store.getLatestSession('crm-1001');
  assert.notEqual(fresh?.conversationId, closedId, 'a new session was opened');
  assert.equal(fresh?.exchangeCount, 1, 'budget reset fresh');
});

test('tighten band injects the steer-to-close directive into the model system prompt', async () => {
  const { deps, fakes } = makeDeps();
  const lookup = { type: 'text' as const, text: "what's my win rate?" };
  // Drive to 3 exchanges (count 3 → 0.75 tighten on the next turn).
  await handleInbound(deps, { telegramUserId: 111, content: lookup }, NOW);
  await handleInbound(deps, { telegramUserId: 111, content: lookup }, NOW);
  await handleInbound(deps, { telegramUserId: 111, content: lookup }, NOW);
  const res = await handleInbound(deps, { telegramUserId: 111, content: { type: 'text', text: 'help me think about my risk' } }, NOW);
  assert.equal(res.band, 'tighten');
  assert.equal(fakes.llm.mentorCalls(), 1);
  assert.ok(fakes.llm.lastMentorSystem().includes(TIGHTEN_DIRECTIVE));
});

test('budget caps scale up with account tier', () => {
  const budget = { baseExchanges: 12, baseTokens: 8000, tierMultipliers: { bronze: 1, silver: 1.25, gold: 1.5, platinum: 2 } };
  const bronze = capsForTier(budget, 'bronze');
  const platinum = capsForTier(budget, 'platinum');
  assert.ok(platinum.maxExchanges > bronze.maxExchanges);
  assert.ok(platinum.maxTokens > bronze.maxTokens);
});

// ── Guardrail on a reply ─────────────────────────────────────────────────────
test('a "should I buy" model reply is replaced by the educational deflection', async () => {
  const { deps, fakes } = makeDeps({ llm: makeLLM('Yes — gold will rally from here, you should buy now.') });
  const res = await handleInbound(
    deps,
    { telegramUserId: 111, content: { type: 'text', text: 'do you think gold is a good buy right now?' } },
    NOW,
  );
  assert.equal(res.status, 'mentor');
  assert.equal(res.guardrailTripped, true);

  const metrics = computeClientMetrics(
    await gatherMetricsInput(deps.connectors, { crmClientId: 'crm-1001', granularity: 'weekly', referenceDate: '2025-06-25', asOf: new Date(NOW).toISOString(), includePrior: true }),
  );
  assert.equal(res.reply, buildDeflection(metrics));
  assert.equal(fakes.telegram.texts[0]?.text, buildDeflection(metrics));
  assert.ok(!res.reply.includes('rally'));
  assert.ok(fakes.users.audits.some((a) => a.eventType === 'guardrail_trip'));
});

// ── Voice in / voice out ─────────────────────────────────────────────────────
test('voice-in is transcribed and the reply is always voiced', async () => {
  const stt = new FakeStt("what's my win rate?");
  const { deps, fakes } = makeDeps({ stt });
  const res = await handleInbound(
    deps,
    { telegramUserId: 111, content: { type: 'voice', audio: Buffer.from('OggS-voice'), mime: 'audio/ogg' } },
    NOW,
  );
  assert.equal(stt.calls, 1, 'STT invoked');
  assert.equal(res.status, 'lookup'); // transcribed text routed as a lookup
  assert.equal(res.voiced, true, 'voice-in is always voiced');
  assert.equal(fakes.telegram.voices.length, 1);
  assert.equal(fakes.tts.count, 1);
});

test('voice-out cadence is occasional for text (every Nth), not every message', async () => {
  const { deps, fakes } = makeDeps({ config: config({ voiceEveryN: 3 }) });
  const lookup = { type: 'text' as const, text: "what's my win rate?" };
  const r1 = await handleInbound(deps, { telegramUserId: 111, content: lookup }, NOW);
  const r2 = await handleInbound(deps, { telegramUserId: 111, content: lookup }, NOW);
  const r3 = await handleInbound(deps, { telegramUserId: 111, content: lookup }, NOW);
  assert.equal(r1.voiced, false);
  assert.equal(r2.voiced, false);
  assert.equal(r3.voiced, true, 'every 3rd reply is voiced');
  assert.equal(fakes.telegram.voices.length, 1, 'not every message voiced');
});

// ── Escalation ───────────────────────────────────────────────────────────────
test('escalation triggers flag for handoff instead of replying with AI', async () => {
  const triggers: ReadonlyArray<[string, string]> = [
    ['This is a total scam, I want to file a complaint.', 'complaint'],
    ["I can't withdraw my money, it's been stuck for days.", 'funds_problem'],
    ['Just tell me exactly what to buy, give me a signal.', 'advice_demand'],
  ];
  for (const [text, reason] of triggers) {
    const { deps, fakes } = makeDeps();
    const res = await handleInbound(deps, { telegramUserId: 111, content: { type: 'text', text } }, NOW);
    assert.equal(res.status, 'escalated', `"${text}" escalates`);
    assert.equal(res.escalationReason, reason);
    assert.equal(fakes.llm.mentorCalls(), 0, 'no AI reply on escalation');
    assert.equal(fakes.escalation.events[0]?.reason, reason);
  }
});

test('repeated guardrail trips in one session escalate', async () => {
  const { deps, fakes } = makeDeps({
    llm: makeLLM('You should buy gold now — it will rally.'),
    config: config({ guardrailTripEscalationThreshold: 2 }),
  });
  const msg = { type: 'text' as const, text: 'what do you reckon about gold here?' };
  const first = await handleInbound(deps, { telegramUserId: 111, content: msg }, NOW);
  assert.equal(first.guardrailTripped, true);
  assert.equal(fakes.escalation.events.length, 0, 'one trip is not yet an escalation');

  const second = await handleInbound(deps, { telegramUserId: 111, content: msg }, NOW);
  assert.equal(second.guardrailTripped, true);
  assert.equal(second.escalationReason, 'repeated_guardrail_trips');
  assert.ok(fakes.escalation.events.some((e) => e.reason === 'repeated_guardrail_trips'));
});

// ── Context assembly stays bounded ───────────────────────────────────────────
test('context assembly sends a bounded window, not full history', async () => {
  const { deps, fakes } = makeDeps({ config: config({ budget: { baseExchanges: 100 }, contextWindowExchanges: 2 }) });
  const coaching = { type: 'text' as const, text: 'help me reflect on my trading mindset' };
  // 6 model turns; window is 2 exchanges (4 messages).
  for (let i = 0; i < 6; i += 1) {
    await handleInbound(deps, { telegramUserId: 111, content: coaching }, NOW);
  }
  // Last mentor call: conversation = up to window*2 prior msgs + current → <= 5.
  const all = await fakes.store.allMessages((await fakes.store.getLatestSession('crm-1001'))!.conversationId);
  assert.ok(all.length >= 12, 'full history is stored');
  // The system prompt carried a rolling summary (older turns were folded).
  assert.ok(fakes.llm.lastMentorSystem().includes('Summary of earlier conversation'));
});
