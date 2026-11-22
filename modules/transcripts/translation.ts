export const translationLanguages = [
  "zh",
  "en",
  "de",
  "af",
  "am",
  "ar",
  "ast",
  "az",
  "ba",
  "be",
  "bg",
  "bn",
  "br",
  "bs",
  "ca",
  "ceb",
  "cs",
  "cy",
  "da",
  "el",
  "es",
  "et",
  "fa",
  "ff",
  "fi",
  "fr",
  "fy",
  "ga",
  "gd",
  "gl",
  "gu",
  "ha",
  "he",
  "hi",
  "hr",
  "ht",
  "hu",
  "hy",
  "id",
  "ig",
  "ilo",
  "is",
  "it",
  "ja",
  "jv",
  "ka",
  "kk",
  "km",
  "kn",
  "ko",
  "lb",
  "lg",
  "ln",
  "lo",
  "lt",
  "lv",
  "mg",
  "mk",
  "ml",
  "mn",
  "mr",
  "ms",
  "my",
  "ne",
  "nl",
  "no",
  "ns",
  "oc",
  "or",
  "pa",
  "pl",
  "ps",
  "pt",
  "ro",
  "ru",
  "sd",
  "si",
  "sk",
  "sl",
  "so",
  "sq",
  "sr",
  "ss",
  "su",
  "sv",
  "sw",
  "ta",
  "th",
  "tl",
  "tn",
  "tr",
  "uk",
  "ur",
  "uz",
  "vi",
  "wo",
  "xh",
  "yi",
  "yo",
  "zu",
] as const;
export type TranslationLanguage = (typeof translationLanguages)[number];
export type TranslationTarget = TranslationLanguage | null;
export const defaultTranslationLanguage: TranslationLanguage = "zh";

export function translationSettings(target: TranslationTarget) {
  return target
    ? { translate: true, translationLanguage: target }
    : { translate: false };
}

export function translationTarget(settings: {
  translate: boolean;
  translationLanguage: TranslationLanguage;
}): TranslationTarget {
  return settings.translate ? settings.translationLanguage : null;
}

export interface Translated {
  translation?: string;
  translationLanguage?: TranslationLanguage;
}
export interface Draft {
  draftTranslation?: {
    language: TranslationLanguage;
    text: string;
    source: string;
  };
}

export function draftText(row: Draft, target: TranslationTarget) {
  return row.draftTranslation?.language === target
    ? row.draftTranslation.text
    : undefined;
}

export function translatedText(
  item: Translated | undefined,
  target: TranslationTarget,
) {
  // Journals written before language selection contain Simplified Chinese.
  return item &&
    (item.translationLanguage ?? defaultTranslationLanguage) === target
    ? item.translation
    : undefined;
}
