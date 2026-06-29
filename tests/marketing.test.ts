import test from 'node:test';
import assert from 'node:assert/strict';

import { MockBrokeretConnector } from '../src/connectors/index.js';
import { InMemoryUserRepository } from '../src/identity/index.js';
import {
  selectSegment,
  scheduleCampaign,
  processMarketing,
  renderTemplate,
  InMemoryOutboundStore,
  type Campaign,
  type MarketingConfig,
  type MarketingDeps,
  type QueueLike,
  type Segment,
  type TelegramSender,
  type OutboundAttachment,
} from '../src/outbound/index.js';

// ── Fakes ────────────────────────────────────────────────────────────────────
class FakeTelegram implements TelegramSender {
  texts: { chatId: number; text: string }[] = [];
  photos: { chatId: number; photo: OutboundAttachment; caption?: string }[] = [];
  voices: { chatId: number; voice: OutboundAttachment; caption?: string }[] = [];
  async sendText(chatId: number, text: string): Promise<void> {
    this.texts.push({ chatId, text });
  }
  async sendDocument(): Promise<void> {}
  async sendPhoto(chatId: number, photo: OutboundAttachment, caption?: string): Promise<void> {
    this.photos.push({ chatId, photo, ...(caption !== undefined ? { caption } : {}) });
  }
  async sendVoice(chatId: number, voice: OutboundAttachment, caption?: string): Promise<void> {
    this.voices.push({ chatId, voice, ...(caption !== undefined ? { caption } : {}) });
  }
}

class FakeQueue implements QueueLike {
  jobs = new Map<string, { name: string; data: unknown; opts: { delay?: number; jobId?: string } }>();
  async add(name: string, data: unknown, opts: { delay?: number; jobId?: string }): Promise<unknown> {
    const id = opts.jobId ?? String(this.jobs.size);
    if (!this.jobs.has(id)) this.jobs.set(id, { name, data, opts });
    return { id };
  }
}

const NOW = Date.parse('2025-06-25T05:00:00.000Z');

// 1001 gold AE marketing=true · 1002 silver GB marketing=false (ai=true)
// 1003 platinum SG marketing=true · 1005 silver DE marketing=false
const COHORT: ReadonlyArray<[string, number]> = [
  ['crm-1001', 111],
  ['crm-1002', 112],
  ['crm-1003', 113],
  ['crm-1005', 115],
];

function makeDeps(opts: { config?: Partial<MarketingConfig>; queue?: FakeQueue; bound?: ReadonlyArray<[string, number]> } = {}): {
  deps: MarketingDeps;
  telegram: FakeTelegram;
  store: InMemoryOutboundStore;
  users: InMemoryUserRepository;
  queue: FakeQueue;
} {
  const users = new InMemoryUserRepository();
  for (const [crmClientId, tg] of opts.bound ?? COHORT) {
    void users.bind({ crmClientId, telegramUserId: tg, boundAt: '2025-06-01T00:00:00Z' });
  }
  const telegram = new FakeTelegram();
  const store = new InMemoryOutboundStore();
  const queue = opts.queue ?? new FakeQueue();
  const deps: MarketingDeps = {
    brokeret: new MockBrokeretConnector(),
    users,
    telegram,
    store,
    config: { hourLocal: 10, weeklyCap: 3, ...opts.config },
    clock: { now: () => NOW },
    queue,
  };
  return { deps, telegram, store, users, queue };
}

const textCampaign = (id: string, segment: Segment = {}): Campaign => ({
  id,
  name: `Campaign ${id}`,
  payload: { kind: 'text', body: 'Hi {{first_name}}, your {{tier}} perks are live!' },
  segment,
});

// ── Segmentation + consent ───────────────────────────────────────────────────
test('a campaign reaches only consent_marketing=true users in the segment', async () => {
  const { deps } = makeDeps();
  const seg = await selectSegment(deps, {});
  assert.deepEqual(
    seg.members.map((m) => m.crmClientId).sort(),
    ['crm-1001', 'crm-1003'],
    'only marketing-consented + bound users',
  );
  assert.equal(seg.count, 2);
});

test('marketing opt-out is honored independently of the mentor opt-in', async () => {
  const { deps } = makeDeps();
  // crm-1002 has consent_ai_messaging=true (mentor) but consent_marketing=false.
  const c1002 = await deps.brokeret.getClient('crm-1002');
  assert.equal(c1002.consentAiMessaging, true, 'mentor opt-in');
  assert.equal(c1002.consentMarketing, false, 'marketing opt-out');

  const seg = await selectSegment(deps, {});
  assert.ok(!seg.members.some((m) => m.crmClientId === 'crm-1002'), 'no marketing to opted-out user');

  // And processMarketing refuses even if a job slips through.
  const res = await processMarketing(deps, { campaign: textCampaign('c1'), crmClientId: 'crm-1002' }, NOW);
  assert.equal(res.status, 'no_consent');
});

test('segment dry-run returns the correct reach count (tier / country filters)', async () => {
  const { deps } = makeDeps();
  assert.equal((await selectSegment(deps, { tiers: ['gold'] })).count, 1); // crm-1001
  assert.equal((await selectSegment(deps, { countries: ['SG'] })).count, 1); // crm-1003
  assert.equal((await selectSegment(deps, { tiers: ['gold', 'platinum'] })).count, 2);
  assert.equal((await selectSegment(deps, { countries: ['US'] })).count, 0); // crm-1004 not consented/active
  assert.equal((await selectSegment(deps, { timezones: ['Asia/Dubai'] })).count, 1);
});

// ── Personalization (no model call) ──────────────────────────────────────────
test('template substitution personalizes name + tier without an LLM', async () => {
  const { deps, telegram } = makeDeps();
  const res = await processMarketing(deps, { campaign: textCampaign('c1'), crmClientId: 'crm-1001' }, NOW);
  assert.equal(res.status, 'sent');
  assert.equal(telegram.texts[0]?.text, 'Hi Amara, your gold perks are live!');
});

// ── Payload kinds ────────────────────────────────────────────────────────────
test('text, image, and voice payloads all send correctly', async () => {
  // Text
  {
    const { deps, telegram, store } = makeDeps();
    await processMarketing(deps, { campaign: textCampaign('t1'), crmClientId: 'crm-1001' }, NOW);
    assert.equal(telegram.texts.length, 1);
    const logRow = store.logs.find((l) => l.jobType === 'marketing' && l.contentRef === 't1');
    assert.equal(logRow?.status, 'sent');
  }
  // Image
  {
    const { deps, telegram } = makeDeps();
    const campaign: Campaign = {
      id: 'i1',
      name: 'image',
      payload: { kind: 'image', image: Buffer.from('JPEGDATA'), caption: 'For you, {{first_name}}' },
      segment: {},
    };
    await processMarketing(deps, { campaign, crmClientId: 'crm-1001' }, NOW);
    assert.equal(telegram.photos.length, 1);
    assert.equal(telegram.photos[0]?.caption, 'For you, Amara');
  }
  // Voice (pre-recorded; NOT TTS)
  {
    const { deps, telegram, store } = makeDeps();
    const campaign: Campaign = {
      id: 'v1',
      name: 'voice',
      payload: { kind: 'voice', audio: Buffer.from('OggS-preauthored') },
      segment: {},
    };
    await processMarketing(deps, { campaign, crmClientId: 'crm-1001' }, NOW);
    assert.equal(telegram.voices.length, 1);
    assert.equal(telegram.voices[0]?.voice.filename, 'milele.ogg');
    const logRow = store.logs.find((l) => l.jobType === 'marketing' && l.contentRef === 'v1');
    assert.equal(logRow?.voiced, true);
  }
});

// ── Frequency cap across campaigns ───────────────────────────────────────────
test('weekly frequency cap blocks the N+1th message across multiple campaigns', async () => {
  const { deps, telegram } = makeDeps({ config: { weeklyCap: 2 } });
  const a = await processMarketing(deps, { campaign: textCampaign('A'), crmClientId: 'crm-1001' }, NOW);
  const b = await processMarketing(deps, { campaign: textCampaign('B'), crmClientId: 'crm-1001' }, NOW);
  const c = await processMarketing(deps, { campaign: textCampaign('C'), crmClientId: 'crm-1001' }, NOW);
  assert.equal(a.status, 'sent');
  assert.equal(b.status, 'sent');
  assert.equal(c.status, 'rate_capped', 'N+1th blocked across campaigns');
  assert.equal(telegram.texts.length, 2, 'only 2 sent');

  // A week later the cap resets.
  const later = await processMarketing(deps, { campaign: textCampaign('D'), crmClientId: 'crm-1001' }, NOW + 8 * 24 * 60 * 60 * 1000);
  assert.equal(later.status, 'sent');
});

test('per-campaign idempotency: the same campaign+user is not sent twice', async () => {
  const { deps, telegram } = makeDeps();
  const first = await processMarketing(deps, { campaign: textCampaign('once'), crmClientId: 'crm-1001' }, NOW);
  const second = await processMarketing(deps, { campaign: textCampaign('once'), crmClientId: 'crm-1001' }, NOW);
  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'skipped');
  assert.equal(telegram.texts.length, 1);
});

// ── Scheduling at sensible local hours ───────────────────────────────────────
test('campaign is scheduled per-user at a sensible local hour, not the middle of the night', async () => {
  const { deps, queue } = makeDeps();
  const result = await scheduleCampaign(deps, textCampaign('promo', {}), NOW);
  assert.equal(result.reach, 2);
  assert.equal(queue.jobs.size, 2);

  for (const s of result.scheduled) {
    const client = await deps.brokeret.getClient(s.crmClientId);
    const hour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: client.timezone, hourCycle: 'h23', hour: '2-digit' }).format(
        new Date(s.fireAtMs),
      ),
    );
    assert.equal(hour, 10, `${s.crmClientId} scheduled at 10:00 local`);
    assert.ok(s.fireAtMs > NOW);
  }

  // Re-scheduling does not double-enqueue.
  await scheduleCampaign(deps, textCampaign('promo', {}), NOW);
  assert.equal(queue.jobs.size, 2);
});

// ── renderTemplate unit ──────────────────────────────────────────────────────
test('renderTemplate handles name + tier variants', () => {
  const client = { name: 'Amara Okafor', accountTier: 'gold' } as Parameters<typeof renderTemplate>[1];
  assert.equal(renderTemplate('Hey {{first_name}} ({{tier}})', client), 'Hey Amara (gold)');
  assert.equal(renderTemplate('{{ name }} / {{ account_tier }}', client), 'Amara / gold');
});
