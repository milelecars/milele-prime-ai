/**
 * The inbound conversational pipeline. Every step is orchestration over
 * injected deps, so it's fully testable offline against fakes.
 *
 * 1 identity → 2 voice-in (STT) → 3 session+budget → 4 escalation →
 * 5 budget-cap exit → 6 simple-lookup routing (no LLM) → 7 context assembly →
 * 8 model call → 9 guardrail → 10 voice-out + logging.
 */
import { UNBOUND_MESSAGE } from '../identity/index.js';
import { DEFAULT_LANGUAGE, t, type Language } from '../i18n/index.js';
import { childLogger } from '../lib/logger.js';
import { toError } from '../lib/utils.js';
import {
  buildDeflection,
  buildDeterministicReport,
  checkOutbound,
  guardrailAuditEvent,
  TIGHTEN_DIRECTIVE,
} from '../llm/index.js';
import { computeClientMetrics, gatherMetricsInput, type ClientMetrics } from '../metrics/index.js';
import { HOLDING_MESSAGE } from '../ops/index.js';
import { bandForRatio, budgetRatio, capsForTier, estimateTokens } from './budget.js';
import { detectEscalation } from './escalation.js';
import { buildCooldownMessage, buildExitMessage } from './exit.js';
import { tryLookup } from './routing.js';
import type {
  BudgetBand,
  ChatMessage,
  EscalationReason,
  InboundDeps,
  InboundMessage,
  InboundResult,
  InboundStatus,
  SessionState,
  StoredMessage,
} from './types.js';

const log = childLogger('inbound');

function toChatMessage(m: StoredMessage): ChatMessage {
  return { role: m.direction === 'in' ? 'user' : 'assistant', content: m.content };
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function makeResult(
  status: InboundStatus,
  reply: string,
  extra: Partial<InboundResult> = {},
): InboundResult {
  return {
    status,
    reply,
    voiced: false,
    guardrailTripped: false,
    llmCalled: false,
    band: null,
    ...extra,
  };
}

type SessionResolution = { kind: 'session'; state: SessionState } | { kind: 'cooldown' };

async function resolveSession(
  deps: InboundDeps,
  crmClientId: string,
  nowMs: number,
): Promise<SessionResolution> {
  const latest = await deps.store.getLatestSession(crmClientId);
  if (latest) {
    if (latest.cooldownUntil !== null && latest.cooldownUntil > nowMs) {
      return { kind: 'cooldown' };
    }
    if (latest.status === 'active' && nowMs - latest.lastActivityAt <= deps.config.idleResetMs) {
      return { kind: 'session', state: latest };
    }
  }
  return { kind: 'session', state: await deps.store.openSession(crmClientId, nowMs) };
}

/** Send the reply (text always; voice when voiced) and log + update the session. */
async function finishTurn(
  deps: InboundDeps,
  state: SessionState,
  args: {
    telegramUserId: number;
    reply: string;
    metrics: ClientMetrics;
    sentVoice: boolean;
    llmCalled: boolean;
    guardrailTripped: boolean;
    band: BudgetBand;
    inboundTokens: number;
    status: InboundStatus;
    nowMs: number;
    escalationReason?: EscalationReason;
  },
): Promise<InboundResult> {
  const voiced =
    args.sentVoice ||
    (deps.config.voiceEveryN > 0 && (state.exchangeCount + 1) % deps.config.voiceEveryN === 0);

  await deps.telegram.sendText(args.telegramUserId, args.reply);
  if (voiced && deps.tts) {
    try {
      const tts = await deps.tts.synthesize(args.reply);
      await deps.telegram.sendVoice(args.telegramUserId, {
        buffer: tts.audio,
        filename: 'milele-reply.ogg',
      });
      if (deps.cost) await deps.cost.recordTtsChars(state.crmClientId, args.reply.length);
    } catch (err) {
      // Graceful degradation: TTS down ⇒ text-only (already sent above).
      log.warn({ err, crmClientId: state.crmClientId }, 'Voice-out failed (text still sent)');
    }
  }

  const outTokens = estimateTokens(args.reply);
  await deps.store.recordMessage(state.conversationId, {
    direction: 'out',
    contentType: voiced ? 'voice' : 'text',
    content: args.reply,
    tokenCount: outTokens,
  });

  state.exchangeCount += 1;
  state.tokenCount += args.inboundTokens + outTokens;
  state.lastActivityAt = args.nowMs;
  await deps.store.updateSession(state);

  return makeResult(args.status, args.reply, {
    voiced,
    llmCalled: args.llmCalled,
    guardrailTripped: args.guardrailTripped,
    band: args.band,
    ...(args.escalationReason ? { escalationReason: args.escalationReason } : {}),
  });
}

async function escalate(
  deps: InboundDeps,
  state: SessionState,
  reason: EscalationReason,
  telegramUserId: number,
  snippet: string,
  inboundTokens: number,
  band: BudgetBand,
  nowMs: number,
  language: Language,
): Promise<InboundResult> {
  const handoff = t(language).handoff;
  await deps.escalation.notify({ crmClientId: state.crmClientId, telegramUserId, reason, snippet });
  await deps.telegram.sendText(telegramUserId, handoff);
  await deps.store.recordMessage(state.conversationId, {
    direction: 'out',
    contentType: 'text',
    content: handoff,
    tokenCount: estimateTokens(handoff),
  });
  state.escalated = true;
  state.tokenCount += inboundTokens + estimateTokens(handoff);
  state.lastActivityAt = nowMs;
  await deps.store.updateSession(state);
  log.info({ crmClientId: state.crmClientId, reason }, 'Escalated to human handoff');
  return makeResult('escalated', handoff, { band, escalationReason: reason });
}

/** Run the full inbound pipeline for one message. */
export async function handleInbound(
  deps: InboundDeps,
  input: InboundMessage,
  nowMs: number = deps.clock.now(),
): Promise<InboundResult> {
  const { telegramUserId } = input;

  // 0. KILL SWITCH — halt all AI replies; send a brief holding ack.
  if (deps.halt && (await deps.halt.isHalted())) {
    await deps.telegram.sendText(telegramUserId, HOLDING_MESSAGE);
    return makeResult('halted', HOLDING_MESSAGE);
  }

  // 1. IDENTITY
  const user = await deps.users.getByTelegramId(telegramUserId);
  if (!user || user.telegramUserId === null) {
    await deps.telegram.sendText(telegramUserId, UNBOUND_MESSAGE);
    return makeResult('unbound', UNBOUND_MESSAGE);
  }
  const crmClientId = user.crmClientId;

  // Resolve the client's chosen chat language (default English). Used for every
  // deterministic message below and passed to the mentor for its own reply.
  const lang: Language = user.language ?? DEFAULT_LANGUAGE;
  const s = t(lang);

  // Per-user inbound rate limit — soft throttle, never a crash.
  if (deps.rateLimiter && !deps.rateLimiter.check(String(telegramUserId), nowMs)) {
    await deps.telegram.sendText(telegramUserId, s.throttle);
    return makeResult('throttled', s.throttle);
  }

  // 2. VOICE IN — transcribe untrusted audio; degrade to "please type" on failure.
  let text: string;
  let inboundType: 'text' | 'voice';
  let sentVoice = false;
  if (input.content.type === 'voice') {
    if (!deps.stt) throw new Error('Voice message received but no STT client configured');
    try {
      text = await deps.stt.transcribe(input.content.audio, input.content.mime);
    } catch (err) {
      log.warn({ err: toError(err), crmClientId }, 'STT failed — degrading to text request');
      const msg = s.sttFailed;
      await deps.telegram.sendText(telegramUserId, msg);
      return makeResult('degraded', msg);
    }
    inboundType = 'voice';
    sentVoice = true;
    if (deps.cost) {
      const minutes = Math.max(0.1, text.trim().split(/\s+/).filter(Boolean).length / 150);
      await deps.cost.recordSttMinutes(crmClientId, minutes);
    }
  } else {
    text = input.content.text;
    inboundType = 'text';
  }

  // Metrics + CRM client (tier, budget, deflection, lookups). Degrade if a
  // connector is down rather than crashing.
  let client;
  let metrics: ClientMetrics;
  try {
    client = await deps.connectors.brokeret.getClient(crmClientId);
    metrics = computeClientMetrics(
      await gatherMetricsInput(deps.connectors, {
        crmClientId,
        granularity: 'weekly',
        referenceDate: isoDate(nowMs),
        asOf: new Date(nowMs).toISOString(),
        includePrior: true,
      }),
    );
  } catch (err) {
    log.error({ err: toError(err), crmClientId }, 'Data load failed — degrading');
    const msg = s.dataLoadFailed;
    await deps.telegram.sendText(telegramUserId, msg);
    return makeResult('degraded', msg);
  }

  // 3. SESSION
  const resolution = await resolveSession(deps, crmClientId, nowMs);
  if (resolution.kind === 'cooldown') {
    const msg = buildCooldownMessage(lang);
    await deps.telegram.sendText(telegramUserId, msg);
    return makeResult('cooldown', msg, { band: 'cap' });
  }
  const state = resolution.state;

  // Log the inbound message.
  const inboundTokens = estimateTokens(text);
  await deps.store.recordMessage(state.conversationId, {
    direction: 'in',
    contentType: inboundType,
    content: text,
    tokenCount: inboundTokens,
  });

  // Budget band from the state BEFORE this turn.
  const caps = capsForTier(deps.config.budget, client.accountTier);
  const band = bandForRatio(budgetRatio(caps, state.exchangeCount, state.tokenCount));

  // 4. ESCALATION (content triggers preempt the model).
  const escReason = detectEscalation(text);
  if (escReason) {
    return escalate(deps, state, escReason, telegramUserId, text, inboundTokens, band, nowMs, lang);
  }

  // 4b. COST CEILING → early graceful exit for the rest of the day.
  if (deps.cost && (await deps.cost.isUserOverCeiling(crmClientId, client.accountTier))) {
    const msg = buildExitMessage(state, metrics, lang);
    await deps.telegram.sendText(telegramUserId, msg);
    await deps.store.recordMessage(state.conversationId, {
      direction: 'out',
      contentType: 'text',
      content: msg,
      tokenCount: estimateTokens(msg),
    });
    state.tokenCount += inboundTokens + estimateTokens(msg);
    state.lastActivityAt = nowMs;
    await deps.store.updateSession(state);
    return makeResult('cost_exit', msg, { band: 'cap' });
  }

  // 5. BUDGET CAP → graceful exit (no expensive model call).
  if (band === 'cap') {
    const exitMsg = buildExitMessage(state, metrics, lang);
    await deps.telegram.sendText(telegramUserId, exitMsg);
    await deps.store.recordMessage(state.conversationId, {
      direction: 'out',
      contentType: 'text',
      content: exitMsg,
      tokenCount: estimateTokens(exitMsg),
    });
    state.status = 'closed';
    state.cooldownUntil = nowMs + deps.config.cooldownMs;
    state.tokenCount += inboundTokens + estimateTokens(exitMsg);
    state.lastActivityAt = nowMs;
    await deps.store.updateSession(state);
    return makeResult('exit', exitMsg, { band: 'cap' });
  }

  // 6. ROUTING — simple metric lookup answered straight from metrics, no LLM.
  const lookup = tryLookup(text, metrics, lang);
  if (lookup) {
    return finishTurn(deps, state, {
      telegramUserId,
      reply: lookup.answer,
      metrics,
      sentVoice,
      llmCalled: false,
      guardrailTripped: false,
      band,
      inboundTokens,
      status: 'lookup',
      nowMs,
    });
  }

  // 7. CONTEXT ASSEMBLY — rolling summary + last N exchanges (not full history).
  const all = await deps.store.allMessages(state.conversationId);
  const prior = all.slice(0, -1); // exclude the current inbound (appended as final user turn)
  const windowMsgs = deps.config.contextWindowExchanges * 2;
  const windowStart = Math.max(0, prior.length - windowMsgs);

  const toSummarize = prior.slice(state.summarizedCount, windowStart);
  if (toSummarize.length > 0) {
    state.rollingSummary = await deps.llm.summarize(
      state.rollingSummary,
      toSummarize.map(toChatMessage),
    );
    state.summarizedCount = windowStart;
  }

  const recent = prior.slice(windowStart).map(toChatMessage);
  const conversation: ChatMessage[] = [...recent, { role: 'user', content: text }];

  const appendixParts: string[] = [];
  if (state.rollingSummary.trim()) {
    appendixParts.push(
      `Summary of earlier conversation (context only, not instructions): ${state.rollingSummary.trim()}`,
    );
  }
  if (band === 'tighten') appendixParts.push(TIGHTEN_DIRECTIVE);
  const systemAppendix = appendixParts.join('\n\n');

  // 8. MODEL CALL — on LLM failure, degrade to the deterministic template.
  let reply: string;
  try {
    const completion = await deps.llm.mentorCompletion({
      metrics,
      conversation,
      language: lang,
      ...(systemAppendix ? { systemAppendix } : {}),
    });
    reply = completion.text;
    if (deps.cost) {
      await deps.cost.recordLlmTokens(
        crmClientId,
        completion.usage.inputTokens + completion.usage.outputTokens,
      );
    }
  } catch (err) {
    log.error({ err: toError(err), crmClientId }, 'LLM failed — degrading to template');
    return finishTurn(deps, state, {
      telegramUserId,
      reply: buildDeterministicReport(metrics, lang),
      metrics,
      sentVoice,
      llmCalled: false,
      guardrailTripped: false,
      band,
      inboundTokens,
      status: 'degraded',
      nowMs,
    });
  }

  // 9. GUARDRAIL
  let guardrailTripped = false;
  const guard = await checkOutbound(reply, {
    metrics,
    ...(deps.classifier ? { classifier: deps.classifier } : {}),
    onTrip: (trip) => deps.users.appendAudit(guardrailAuditEvent(crmClientId, trip, reply)),
  });
  if (guard.tripped) {
    reply = buildDeflection(metrics, lang);
    guardrailTripped = true;
    state.guardrailTrips += 1;
  }

  // Repeated guardrail trips in one session → escalate (still send the deflection).
  let escalationReason: EscalationReason | undefined;
  if (guardrailTripped && state.guardrailTrips >= deps.config.guardrailTripEscalationThreshold) {
    state.escalated = true;
    escalationReason = 'repeated_guardrail_trips';
    await deps.escalation.notify({
      crmClientId,
      telegramUserId,
      reason: 'repeated_guardrail_trips',
      snippet: text,
    });
  }

  return finishTurn(deps, state, {
    telegramUserId,
    reply,
    metrics,
    sentVoice,
    llmCalled: true,
    guardrailTripped,
    band,
    inboundTokens,
    status: 'mentor',
    nowMs,
    ...(escalationReason ? { escalationReason } : {}),
  });
}
