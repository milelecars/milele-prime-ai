/**
 * Kill switch. A single runtime flag that halts ALL outbound (daily reports,
 * marketing) and AI replies, flippable without a redeploy. While halted,
 * inbound messages get a brief holding acknowledgement instead of an AI reply.
 */
import type { Redis } from 'ioredis';

export interface HaltGate {
  isHalted(): Promise<boolean> | boolean;
}

/** The message shown to inbound users while the system is halted. */
export const HOLDING_MESSAGE = "I'm taking a quick break — back shortly. Your message is safe; ping me again in a bit.";

/** Process-local halt gate (default; also used in tests). */
export class InMemoryHaltGate implements HaltGate {
  private halted: boolean;
  constructor(initial = false) {
    this.halted = initial;
  }
  isHalted(): boolean {
    return this.halted;
  }
  set(value: boolean): void {
    this.halted = value;
  }
}

/**
 * Redis-backed halt gate so the flag is shared across web + worker processes
 * and survives restarts. Reads a single key on each check (cheap).
 */
export class RedisHaltGate implements HaltGate {
  constructor(
    private readonly redis: Redis,
    private readonly key = 'milele:system_halt',
  ) {}
  async isHalted(): Promise<boolean> {
    const v = await this.redis.get(this.key);
    return v === '1' || v === 'true';
  }
  async set(value: boolean): Promise<void> {
    await this.redis.set(this.key, value ? '1' : '0');
  }
}

/** Default process-local gate, initialised from `SYSTEM_HALT`. */
let defaultGate: InMemoryHaltGate | undefined;

export function getHaltGate(initial = false): InMemoryHaltGate {
  if (!defaultGate) defaultGate = new InMemoryHaltGate(initial);
  return defaultGate;
}
