/**
 * Core daily-report logic for one client+date. Pure orchestration over injected
 * deps (connectors, llm, store, telegram, optional pdf/tts) — no global state,
 * so it's testable against mocks.
 *
 * The daily drop is THREE sibling outputs from the same metrics:
 *   - text  : the mentor narrative (or deterministic template if guardrail trips)
 *   - PDF   : built from the ClientMetrics object (never from the text)
 *   - voice : TTS of the narrative TEXT (never of the PDF)
 *
 * Idempotent: a client+date that has already been SENT is skipped.
 */
import { childLogger } from '../lib/logger.js';
import { toError } from '../lib/utils.js';
import {
  buildDeterministicReport,
  checkOutbound,
  guardrailAuditEvent,
} from '../llm/index.js';
import { computeClientMetrics, gatherMetricsInput } from '../metrics/index.js';
import type {
  DailyReportDeps,
  DailyReportJobData,
  DailyReportResult,
  DailyReportStatus,
} from './types.js';

const log = childLogger('outbound:daily');

const DAILY_TRIGGER = 'Please give me my daily trading summary.';

function result(
  crmClientId: string,
  reportDate: string,
  status: DailyReportStatus,
  extra: Partial<DailyReportResult> = {},
): DailyReportResult {
  return {
    crmClientId,
    reportDate,
    status,
    guardrailTripped: false,
    voiced: false,
    ttsCharCount: 0,
    hasPdf: false,
    ...extra,
  };
}

/** Process the daily report for a single client+date. */
export async function processDailyReport(
  deps: DailyReportDeps,
  job: DailyReportJobData,
): Promise<DailyReportResult> {
  const { crmClientId, reportDate } = job;
  const now = () => new Date(deps.clock.now()).toISOString();

  // 0. KILL SWITCH — halt all outbound instantly.
  if (deps.halt && (await deps.halt.isHalted())) {
    log.info({ crmClientId, reportDate }, 'System halted — skipping daily report');
    return result(crmClientId, reportDate, 'halted');
  }

  // 1. Idempotency — claim the slot; bail if already sent.
  const claim = await deps.store.claimDailyReport(crmClientId, reportDate);
  if (claim.alreadySent) {
    log.debug({ crmClientId, reportDate }, 'Daily report already sent — skipping');
    return result(crmClientId, reportDate, 'skipped');
  }

  // 2. Consent (source of truth: the CRM connector).
  const client = await deps.connectors.brokeret.getClient(crmClientId);
  if (!client.consentAiMessaging) {
    await deps.store.updateOutboundLog(claim.id, { status: 'failed', contentRef: 'no_consent' });
    return result(crmClientId, reportDate, 'no_consent');
  }

  // 3. Binding — we can only send to a bound Telegram user.
  const bound = await deps.users.getByCrmId(crmClientId);
  if (!bound || bound.telegramUserId === null) {
    await deps.store.updateOutboundLog(claim.id, { status: 'failed', contentRef: 'unbound' });
    return result(crmClientId, reportDate, 'unbound');
  }
  const chatId = bound.telegramUserId;

  // 4. Metrics — compute and persist for this date.
  const input = await gatherMetricsInput(deps.connectors, {
    crmClientId,
    granularity: deps.config.reportGranularity,
    referenceDate: reportDate,
    asOf: `${reportDate}T${String(deps.config.reportHourLocal).padStart(2, '0')}:00:00.000Z`,
    includePrior: true,
  });
  const metrics = computeClientMetrics(input);
  await deps.store.saveDailyMetrics(crmClientId, reportDate, metrics);

  // 5. Mentor narrative (ONE call). The source for text AND (later) voice.
  //    Graceful degradation: if the LLM is down, fall back to the template.
  let narrativeText: string | null = null;
  try {
    const completion = await deps.llm.mentorCompletion({
      metrics,
      conversation: [{ role: 'user', content: DAILY_TRIGGER }],
    });
    narrativeText = completion.text;
    if (deps.cost) {
      await deps.cost.recordLlmTokens(
        crmClientId,
        completion.usage.inputTokens + completion.usage.outputTokens,
      );
    }
  } catch (err) {
    log.warn({ err: toError(err), crmClientId }, 'LLM failed — using deterministic template');
  }

  // 6. Guardrail — on a trip (or no LLM), fall back to a deterministic template.
  let guardrailTripped = false;
  let narrative: string;
  if (narrativeText === null) {
    narrative = buildDeterministicReport(metrics);
  } else {
    const guard = await checkOutbound(narrativeText, {
      metrics,
      ...(deps.classifier ? { classifier: deps.classifier } : {}),
      onTrip: (trip) =>
        deps.users.appendAudit(guardrailAuditEvent(crmClientId, trip, narrativeText ?? '')),
    });
    guardrailTripped = guard.tripped;
    narrative = guard.tripped ? buildDeterministicReport(metrics) : narrativeText;
  }

  // 7. Send the TEXT, then mark sent + log the message. Marking sent right after
  // the primary delivery guarantees a retry never double-sends the text; the PDF
  // and voice are best-effort enrichments.
  await deps.telegram.sendText(chatId, narrative);
  await deps.store.updateOutboundLog(claim.id, {
    status: 'sent',
    sentAt: now(),
    contentRef: 'text',
  });
  await deps.store.recordMessage({
    crmClientId,
    direction: 'out',
    contentType: 'text',
    content: narrative,
    tokenCount: Math.ceil(narrative.length / 4),
  });

  let hasPdf = false;
  let voiced = false;
  let ttsCharCount = 0;

  // 8. PDF — built from metrics, attached to the drop.
  if (deps.pdf) {
    try {
      const buffer = await deps.pdf(metrics, client);
      await deps.telegram.sendDocument(
        chatId,
        { buffer, filename: `milele-${reportDate}.pdf` },
        `${deps.config.brandName} — ${reportDate}`,
      );
      hasPdf = true;
    } catch (err) {
      log.warn({ err: toError(err), crmClientId }, 'PDF generation/send failed (non-fatal)');
    }
  }

  // 9. Voice — TTS of the narrative TEXT (never the PDF), native OGG/Opus.
  if (deps.config.voiceEnabled && deps.tts) {
    try {
      const tts = await deps.tts.synthesize(narrative);
      await deps.telegram.sendVoice(chatId, { buffer: tts.audio, filename: 'milele-note.ogg' });
      voiced = true;
      ttsCharCount = tts.charCount;
      await deps.store.updateOutboundLog(claim.id, { voiced: true, ttsCharCount });
      if (deps.cost) await deps.cost.recordTtsChars(crmClientId, tts.charCount);
    } catch (err) {
      log.warn({ err: toError(err), crmClientId }, 'Voice synthesis/send failed (non-fatal)');
    }
  }

  log.info({ crmClientId, reportDate, guardrailTripped, hasPdf, voiced }, 'Daily report sent');
  return result(crmClientId, reportDate, 'sent', { guardrailTripped, voiced, ttsCharCount, hasPdf });
}
