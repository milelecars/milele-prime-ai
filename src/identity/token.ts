import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { AuthorizationError, ValidationError } from '../lib/errors.js';

/**
 * Connect-token format.
 *
 * Telegram deep-link `start` parameters are limited to 1–64 characters from the
 * alphabet `[A-Za-z0-9_-]`. A full base64url JSON+HMAC payload would overflow
 * that, so we use a compact encoding:
 *
 *   token = base64url(`${expSecondsBase36}:${crmClientId}`) + base64url(hmac[:16])
 *
 * The signature is a fixed-width 22-char suffix (HMAC-SHA256 truncated to 128
 * bits — standard and well above the 80-bit minimum), so no separator char is
 * needed. The payload is everything before the last 22 chars.
 */
const SIG_BYTES = 16;
const SIG_CHARS = 22; // base64url length of 16 bytes (no padding)
const MAX_TOKEN_CHARS = 64;
const TOKEN_ALPHABET = /^[A-Za-z0-9_-]+$/;

const DEFAULT_TTL_MS = 900_000; // 15 minutes

export interface TokenOptions {
  /** HMAC secret. Defaults to `IDENTITY_SIGNING_SECRET`. */
  readonly secret?: string;
  /** Current time in ms (injectable for tests). Defaults to `Date.now()`. */
  readonly now?: number;
}

export interface SignOptions extends TokenOptions {
  /** Token lifetime in ms. Defaults to 15 minutes. */
  readonly ttlMs?: number;
}

export interface SignedToken {
  readonly token: string;
  readonly expiresAt: string; // ISO-8601
}

export interface VerifiedToken {
  readonly crmClientId: string;
  readonly expiresAt: string; // ISO-8601
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

function signature(secret: string, payload: string): string {
  return b64url(hmac(secret, payload).subarray(0, SIG_BYTES));
}

/** Create a signed, short-lived connect token for a CRM client. */
export function signConnectToken(crmClientId: string, options: SignOptions = {}): SignedToken {
  if (!crmClientId) throw new ValidationError('crmClientId is required to sign a connect token');

  const secret = options.secret ?? env.IDENTITY_SIGNING_SECRET;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const expSeconds = Math.floor((now + ttlMs) / 1000);

  const payload = b64url(Buffer.from(`${expSeconds.toString(36)}:${crmClientId}`, 'utf8'));
  const token = payload + signature(secret, payload);

  if (token.length > MAX_TOKEN_CHARS) {
    throw new ValidationError(
      `connect token exceeds Telegram's ${MAX_TOKEN_CHARS}-char start-param limit`,
      { length: token.length, crmClientId },
    );
  }
  return { token, expiresAt: new Date(expSeconds * 1000).toISOString() };
}

/**
 * Verify a connect token's signature and expiry.
 *
 * @throws {ValidationError}    malformed token
 * @throws {AuthorizationError} bad signature or expired
 */
export function verifyConnectToken(token: unknown, options: TokenOptions = {}): VerifiedToken {
  if (
    typeof token !== 'string' ||
    token.length <= SIG_CHARS ||
    token.length > MAX_TOKEN_CHARS ||
    !TOKEN_ALPHABET.test(token)
  ) {
    throw new ValidationError('Malformed connect token');
  }

  const secret = options.secret ?? env.IDENTITY_SIGNING_SECRET;
  const now = options.now ?? Date.now();

  const payload = token.slice(0, -SIG_CHARS);
  const providedSig = token.slice(-SIG_CHARS);
  const expectedSig = signature(secret, payload);

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AuthorizationError('Invalid connect token signature');
  }

  const raw = Buffer.from(payload, 'base64url').toString('utf8');
  const sep = raw.indexOf(':');
  if (sep < 0) throw new ValidationError('Malformed connect token payload');

  const expSeconds = Number.parseInt(raw.slice(0, sep), 36);
  const crmClientId = raw.slice(sep + 1);
  if (!crmClientId || Number.isNaN(expSeconds)) {
    throw new ValidationError('Malformed connect token payload');
  }

  if (expSeconds * 1000 <= now) {
    throw new AuthorizationError('Connect token has expired');
  }

  return { crmClientId, expiresAt: new Date(expSeconds * 1000).toISOString() };
}
