import { signConnectToken, type SignOptions } from './token.js';

export interface ConnectLink {
  readonly token: string;
  readonly link: string;
  readonly expiresAt: string; // ISO-8601
}

export interface GenerateLinkOptions extends SignOptions {
  /** Bot username (with or without a leading `@`). */
  readonly botUsername: string;
}

/** Build a Telegram deep link from a bot username + start token. */
export function buildConnectLink(botUsername: string, token: string): string {
  const handle = botUsername.replace(/^@/, '');
  return `https://t.me/${handle}?start=${token}`;
}

/**
 * Generate a signed, short-lived connect deep link for a CRM client:
 * `https://t.me/<bot>?start=<token>`.
 */
export function generateConnectLink(
  crmClientId: string,
  options: GenerateLinkOptions,
): ConnectLink {
  const { botUsername, ...signOptions } = options;
  const { token, expiresAt } = signConnectToken(crmClientId, signOptions);
  return { token, link: buildConnectLink(botUsername, token), expiresAt };
}
