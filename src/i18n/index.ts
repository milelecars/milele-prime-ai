/**
 * Internationalization for everything the user sees. The mentor's LLM replies
 * are localized by a system-prompt directive (llm/prompts.ts); the deterministic
 * strings are localized through this module.
 *
 * Usage:
 *   const s = t(lang);
 *   telegram.sendText(id, s.throttle);
 *   telegram.sendText(id, s.lookupPnl({ period: periodPhrase(lang, 'weekly'), pnl }));
 */
import { CATALOG, type Strings } from './strings.js';
import { DEFAULT_LANGUAGE, type Language } from './languages.js';

export type { Strings } from './strings.js';
export {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  RTL_LANGUAGES,
  isLanguage,
  isRtl,
  languageInfo,
  languageNative,
  languageEnglishName,
  normalizeLanguage,
  type Language,
  type LanguageInfo,
} from './languages.js';

/** The string bundle for a language (falls back to the default catalog). */
export function t(lang: Language = DEFAULT_LANGUAGE): Strings {
  return CATALOG[lang] ?? CATALOG[DEFAULT_LANGUAGE];
}

export type Granularity = 'daily' | 'weekly';

/** Localized "this week" / "this day" phrase for a metrics window. */
export function periodPhrase(lang: Language, granularity: Granularity): string {
  const s = t(lang);
  return granularity === 'daily' ? s.periodDay : s.periodWeek;
}

/** Localized "daily" / "weekly" adjective for the report title. */
export function periodAdjective(lang: Language, granularity: Granularity): string {
  const s = t(lang);
  return granularity === 'daily' ? s.periodDaily : s.periodWeekly;
}
