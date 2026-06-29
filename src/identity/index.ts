/** Identity binding: connect tokens, deep links, repository, binding + guard. */
import { supabase } from '../db/supabase.js';
import { SupabaseUserRepository } from './supabase-repository.js';
import type { UserRepository } from './repository.js';

export * from './token.js';
export * from './links.js';
export * from './repository.js';
export { InMemoryUserRepository } from './in-memory-repository.js';
export { SupabaseUserRepository } from './supabase-repository.js';
export { bindTelegramUser, BindEvent } from './binding.js';
export type { BindDeps, BindInput, BindResult, BindStatus } from './binding.js';
export { requireBoundUser, UNBOUND_MESSAGE } from './middleware.js';

/** Production repository singleton (Supabase-backed). */
export const userRepository: UserRepository = new SupabaseUserRepository(supabase);
