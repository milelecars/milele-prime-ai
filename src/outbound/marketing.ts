/**
 * Pre-authored marketing campaigns. Messages are written by Zain (NOT
 * LLM-generated) and only lightly personalized via template substitution
 * ({{first_name}}, {{tier}}). Supports text, image, and voice payloads.
 *
 * Consent: gated on `consent_marketing` — a SEPARATE flag from the mentor's
 * `consent_ai_messaging`. Frequency: a weekly cap enforced across all campaigns.
 * Scheduling: per-user local time (reuses Phase 4's timezone math).
 */
import type { AccountTier, BrokeretConnector, CrmClient } from '../connectors/brokeret/types.js';
import type { UserRepository } from '../identity/repository.js';
import { childLogger } from '../lib/logger.js';
import { toError } from '../lib/utils.js';
import type { HaltGate } from '../ops/index.js';
import { localDateInZone, nextLocalHourUtc } from './local-time.js';
import type { OutboundStore, QueueLike, TelegramSender } from './types.js';

const log = childLogger('outbound:marketing');
const JOB_NAME = 'marketing';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// ── Campaign model ───────────────────────────────────────────────────────────
export type MarketingPayload =
  | { readonly kind: 'text'; readonly body: string }
  | { readonly kind: 'image'; readonly image: Buffer; readonly filename?: string; readonly caption?: string }
  | { readonly kind: 'voice'; readonly audio: Buffer; readonly filename?: string; readonly caption?: string };

export interface Segment {
  readonly tiers?: readonly AccountTier[];
  readonly countries?: readonly string[];
  readonly timezones?: readonly string[];
}

export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly payload: MarketingPayload;
  readonly segment: Segment;
}

export interface MarketingConfig {
  readonly hourLocal: number;
  readonly weeklyCap: number;
}

export interface MarketingDeps {
  readonly brokeret: BrokeretConnector;
  readonly users: UserRepository;
  readonly telegram: TelegramSender;
  readonly store: OutboundStore;
  readonly config: MarketingConfig;
  readonly clock: { now(): number };
  readonly queue?: QueueLike;
  readonly halt?: HaltGate;
}

export interface SegmentMember {
  readonly crmClientId: string;
  readonly name: string;
  readonly tier: AccountTier;
  readonly country: string | undefined;
  readonly timezone: string;
  readonly telegramUserId: number;
}

export interface SegmentResult {
  readonly count: number;
  readonly members: readonly SegmentMember[];
}

export type MarketingStatus = 'sent' | 'skipped' | 'no_consent' | 'unbound' | 'rate_capped' | 'halted';

export interface MarketingResult {
  readonly crmClientId: string;
  readonly campaignId: string;
  readonly status: MarketingStatus;
}

export interface MarketingJobData {
  readonly campaign: Campaign;
  readonly crmClientId: string;
}

// ── Personalization (no model call) ──────────────────────────────────────────
/** Substitute {{first_name}} / {{tier}} placeholders from the client profile. */
export function renderTemplate(template: string, client: CrmClient): string {
  const firstName = client.name.trim().split(/\s+/)[0] ?? client.name;
  return template
    .replace(/\{\{\s*(first_?name|name)\s*\}\}/gi, firstName)
    .replace(/\{\{\s*(tier|account_tier)\s*\}\}/gi, client.accountTier);
}

// ── Segmentation + dry-run ───────────────────────────────────────────────────
function matchesSegment(client: CrmClient, segment: Segment): boolean {
  if (segment.tiers && !segment.tiers.includes(client.accountTier)) return false;
  if (segment.timezones && !segment.timezones.includes(client.timezone)) return false;
  if (segment.countries) {
    if (client.country === undefined || !segment.countries.includes(client.country)) return false;
  }
  return true;
}

/**
 * Resolve the reachable audience for a segment: active clients with
 * `consent_marketing = true`, matching the filters, AND a bound Telegram
 * account. The `count` is the dry-run reach.
 */
export async function selectSegment(deps: MarketingDeps, segment: Segment): Promise<SegmentResult> {
  const members: SegmentMember[] = [];
  for (let page = 1; ; page += 1) {
    const { clients, hasMore } = await deps.brokeret.listActiveClients(page, 100);
    for (const entry of clients) {
      const client = await deps.brokeret.getClient(entry.crmClientId);
      if (!client.consentMarketing) continue;
      if (!matchesSegment(client, segment)) continue;
      const bound = await deps.users.getByCrmId(entry.crmClientId);
      if (!bound || bound.telegramUserId === null) continue;
      members.push({
        crmClientId: entry.crmClientId,
        name: client.name,
        tier: client.accountTier,
        country: client.country,
        timezone: client.timezone,
        telegramUserId: bound.telegramUserId,
      });
    }
    if (!hasMore) break;
  }
  return { count: members.length, members };
}

// ── Scheduling ───────────────────────────────────────────────────────────────
export interface ScheduledCampaign {
  readonly campaignId: string;
  readonly reach: number;
  readonly scheduled: ReadonlyArray<{ crmClientId: string; fireAtMs: number; localDate: string }>;
}

/**
 * Schedule a campaign to its segment, one queue job per user at a sensible
 * local hour. Deduped per campaign+user via jobId. Returns the dry-run reach.
 */
export async function scheduleCampaign(
  deps: MarketingDeps,
  campaign: Campaign,
  nowMs: number = deps.clock.now(),
): Promise<ScheduledCampaign> {
  if (!deps.queue) throw new Error('scheduleCampaign requires a queue');
  const segment = await selectSegment(deps, campaign.segment);
  const scheduled: Array<{ crmClientId: string; fireAtMs: number; localDate: string }> = [];

  for (const member of segment.members) {
    const fireAtMs = nextLocalHourUtc(member.timezone, deps.config.hourLocal, nowMs);
    const data: MarketingJobData = { campaign, crmClientId: member.crmClientId };
    await deps.queue.add(JOB_NAME, data, {
      delay: Math.max(0, fireAtMs - nowMs),
      jobId: `mkt:${campaign.id}:${member.crmClientId}`,
    });
    scheduled.push({ crmClientId: member.crmClientId, fireAtMs, localDate: localDateInZone(member.timezone, fireAtMs) });
  }

  log.info({ campaignId: campaign.id, reach: segment.count }, 'Marketing campaign scheduled');
  return { campaignId: campaign.id, reach: segment.count, scheduled };
}

// ── Per-user send (worker) ───────────────────────────────────────────────────
function makeResult(crmClientId: string, campaignId: string, status: MarketingStatus): MarketingResult {
  return { crmClientId, campaignId, status };
}

/** Deliver one campaign message to one user, enforcing consent + weekly cap. */
export async function processMarketing(
  deps: MarketingDeps,
  job: MarketingJobData,
  nowMs: number = deps.clock.now(),
): Promise<MarketingResult> {
  const { campaign, crmClientId } = job;

  // 0. KILL SWITCH — halt all marketing instantly.
  if (deps.halt && (await deps.halt.isHalted())) {
    return makeResult(crmClientId, campaign.id, 'halted');
  }

  // Consent (separate marketing flag).
  const client = await deps.brokeret.getClient(crmClientId);
  if (!client.consentMarketing) return makeResult(crmClientId, campaign.id, 'no_consent');

  // Binding.
  const bound = await deps.users.getByCrmId(crmClientId);
  if (!bound || bound.telegramUserId === null) return makeResult(crmClientId, campaign.id, 'unbound');
  const chatId = bound.telegramUserId;

  // Weekly frequency cap, across ALL campaigns.
  const recentSends = await deps.store.countMarketingSends(crmClientId, nowMs - WEEK_MS);
  if (recentSends >= deps.config.weeklyCap) {
    log.debug({ crmClientId, recentSends }, 'Marketing weekly cap reached — skipping');
    return makeResult(crmClientId, campaign.id, 'rate_capped');
  }

  // Per-campaign idempotency.
  const claim = await deps.store.claimMarketing(campaign.id, crmClientId);
  if (claim.alreadySent) return makeResult(crmClientId, campaign.id, 'skipped');

  // Render + send (no model call).
  let voiced = false;
  try {
    const p = campaign.payload;
    if (p.kind === 'text') {
      await deps.telegram.sendText(chatId, renderTemplate(p.body, client));
    } else if (p.kind === 'image') {
      await deps.telegram.sendPhoto(
        chatId,
        { buffer: p.image, filename: p.filename ?? 'milele.jpg' },
        p.caption ? renderTemplate(p.caption, client) : undefined,
      );
    } else {
      voiced = true;
      await deps.telegram.sendVoice(
        chatId,
        { buffer: p.audio, filename: p.filename ?? 'milele.ogg' },
        p.caption ? renderTemplate(p.caption, client) : undefined,
      );
    }
  } catch (err) {
    await deps.store.updateOutboundLog(claim.id, { status: 'failed', contentRef: campaign.id });
    log.error({ err: toError(err), crmClientId, campaignId: campaign.id }, 'Marketing send failed');
    throw err;
  }

  await deps.store.updateOutboundLog(claim.id, {
    status: 'sent',
    sentAt: new Date(nowMs).toISOString(),
    voiced,
    contentRef: campaign.id,
  });
  log.info({ crmClientId, campaignId: campaign.id, kind: campaign.payload.kind }, 'Marketing sent');
  return makeResult(crmClientId, campaign.id, 'sent');
}
