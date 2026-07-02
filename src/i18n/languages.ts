/**
 * Supported chat languages. The mentor (LLM) speaks all of these natively; the
 * deterministic strings are translated in {@link ./strings.ts}. A user's choice
 * is stored on their `users` row and threaded through the inbound pipeline.
 */

export interface LanguageInfo {
  /** BCP-47 primary subtag we persist and switch on. */
  readonly code: Language;
  /** Endonym shown on the Telegram picker buttons. */
  readonly native: string;
  /** English name, used in the LLM language directive. */
  readonly english: string;
}

export const SUPPORTED_LANGUAGES = [
  { code: 'en', native: 'English', english: 'English' },
  { code: 'ur', native: 'اردو', english: 'Urdu' },
  { code: 'hi', native: 'हिन्दी', english: 'Hindi' },
  { code: 'ar', native: 'العربية', english: 'Arabic' },
  { code: 'fr', native: 'Français', english: 'French' },
  { code: 'es', native: 'Español', english: 'Spanish' },
  { code: 'pt', native: 'Português', english: 'Portuguese' },
] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number]['code'];

/** Fallback used when a user has no stored preference or it can't be resolved. */
export const DEFAULT_LANGUAGE: Language = 'en';

/** Right-to-left languages (for any future rendering concerns). */
export const RTL_LANGUAGES: ReadonlySet<Language> = new Set<Language>(['ur', 'ar']);

const CODES: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));
const INFO_BY_CODE: ReadonlyMap<Language, LanguageInfo> = new Map(
  SUPPORTED_LANGUAGES.map((l) => [l.code, l]),
);

/** Type guard: is `value` one of the supported language codes? */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && CODES.has(value);
}

/** Metadata for a language code. */
export function languageInfo(code: Language): LanguageInfo {
  return INFO_BY_CODE.get(code) ?? SUPPORTED_LANGUAGES[0];
}

/** Endonym (e.g. "العربية") for the picker + confirmations. */
export function languageNative(code: Language): string {
  return languageInfo(code).native;
}

/** English name (e.g. "Arabic") for the LLM directive. */
export function languageEnglishName(code: Language): string {
  return languageInfo(code).english;
}

/**
 * Coerce an arbitrary value (a stored preference, or a Telegram `language_code`
 * such as "en-US" / "pt-BR") to a supported language, falling back to the
 * default. Only the primary subtag is considered.
 */
export function normalizeLanguage(value: string | null | undefined): Language {
  if (!value) return DEFAULT_LANGUAGE;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return isLanguage(primary) ? primary : DEFAULT_LANGUAGE;
}

/** Is this language written right-to-left? */
export function isRtl(code: Language): boolean {
  return RTL_LANGUAGES.has(code);
}
