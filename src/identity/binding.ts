import type { BrokeretConnector } from '../connectors/brokeret/types.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { childLogger } from '../lib/logger.js';
import type { UserRepository } from './repository.js';
import { verifyConnectToken } from './token.js';

const log = childLogger('identity:binding');

export interface BindDeps {
  readonly repo: UserRepository;
  readonly brokeret: BrokeretConnector;
  /** HMAC secret override (defaults to env via token module). */
  readonly secret?: string;
}

export interface BindInput {
  readonly token: string;
  readonly telegramUserId: number;
  /** Injectable clock for tests. */
  readonly now?: number;
}

export type BindStatus = 'bound' | 'already_bound';

export interface BindResult {
  readonly status: BindStatus;
  readonly crmClientId: string;
}

/** Audit event types emitted by the binding flow. */
export const BindEvent = {
  BOUND: 'identity_bound',
  REBIND_NOOP: 'identity_rebind_noop',
  TOKEN_REJECTED: 'identity_bind_token_rejected',
  CLIENT_MISSING: 'identity_bind_client_missing',
  CONFLICT_TELEGRAM: 'identity_bind_conflict_telegram',
  CONFLICT_CRM: 'identity_bind_conflict_crm',
} as const;

/**
 * Bind a Telegram user to a CRM client from a signed connect token.
 *
 * Rules:
 *  - verify signature + expiry (rejects tampered/expired tokens);
 *  - the CRM client must exist;
 *  - re-binding the *same* Telegram↔CRM pair is idempotent (`already_bound`);
 *  - a Telegram ID already bound to a *different* CRM client is rejected;
 *  - a CRM client already bound to a *different* Telegram ID is rejected.
 *
 * Every outcome (success, conflict, rejection) is written to the audit log.
 */
export async function bindTelegramUser(deps: BindDeps, input: BindInput): Promise<BindResult> {
  const { repo, brokeret } = deps;
  const { telegramUserId } = input;

  // 1. Verify token.
  let crmClientId: string;
  try {
    const verifyOptions = {
      ...(input.now !== undefined ? { now: input.now } : {}),
      ...(deps.secret !== undefined ? { secret: deps.secret } : {}),
    };
    ({ crmClientId } = verifyConnectToken(input.token, verifyOptions));
  } catch (err) {
    await repo.appendAudit({
      crmClientId: null,
      eventType: BindEvent.TOKEN_REJECTED,
      detail: { telegramUserId, reason: (err as Error).message },
    });
    throw err;
  }

  // 2. The CRM client must exist.
  try {
    await brokeret.getClient(crmClientId);
  } catch (err) {
    if (err instanceof NotFoundError) {
      await repo.appendAudit({
        crmClientId,
        eventType: BindEvent.CLIENT_MISSING,
        detail: { telegramUserId },
      });
    }
    throw err;
  }

  // 3. Conflict: this Telegram ID is already bound to a different client.
  const byTelegram = await repo.getByTelegramId(telegramUserId);
  if (byTelegram && byTelegram.crmClientId !== crmClientId) {
    await repo.appendAudit({
      crmClientId,
      eventType: BindEvent.CONFLICT_TELEGRAM,
      detail: { telegramUserId, existingCrmClientId: byTelegram.crmClientId },
    });
    log.warn({ telegramUserId, crmClientId }, 'Bind rejected: Telegram ID already bound elsewhere');
    throw new ConflictError('This Telegram account is already linked to a different client', {
      telegramUserId,
      crmClientId,
    });
  }

  // 4. Conflict: this CRM client is already bound to a different Telegram ID.
  const byCrm = await repo.getByCrmId(crmClientId);
  if (byCrm && byCrm.telegramUserId !== null && byCrm.telegramUserId !== telegramUserId) {
    await repo.appendAudit({
      crmClientId,
      eventType: BindEvent.CONFLICT_CRM,
      detail: { telegramUserId, existingTelegramUserId: byCrm.telegramUserId },
    });
    log.warn({ telegramUserId, crmClientId }, 'Bind rejected: CRM client already bound elsewhere');
    throw new ConflictError('This client is already linked to a different Telegram account', {
      telegramUserId,
      crmClientId,
    });
  }

  // 5. Idempotent: the same pair already exists.
  if (byTelegram && byTelegram.crmClientId === crmClientId) {
    await repo.appendAudit({
      crmClientId,
      eventType: BindEvent.REBIND_NOOP,
      detail: { telegramUserId },
    });
    return { status: 'already_bound', crmClientId };
  }

  // 6. Bind.
  const boundAt = new Date(input.now ?? Date.now()).toISOString();
  await repo.bind({ crmClientId, telegramUserId, boundAt });
  await repo.appendAudit({
    crmClientId,
    eventType: BindEvent.BOUND,
    detail: { telegramUserId, boundAt },
  });
  log.info({ telegramUserId, crmClientId }, 'Telegram user bound to CRM client');
  return { status: 'bound', crmClientId };
}
