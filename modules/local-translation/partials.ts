import type { Language } from "../speech/types.ts";

export const wordsPerPreview = 5;

let chineseWords: Intl.Segmenter | undefined;

export function countSourceWords(text: string, language: Language) {
  if (language !== "zh")
    return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  chineseWords ??= new Intl.Segmenter("zh", { granularity: "word" });
  let count = 0;
  for (const word of chineseWords.segment(text)) {
    if (word.isWordLike) count++;
  }
  return count;
}
