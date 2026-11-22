import type { Language } from "../speech/types.ts";
import type { TranslationLanguage } from "../transcripts/translation.ts";

export interface LocalTranslator {
  prepare(): Promise<void>;
  translate(
    source: Language,
    target: TranslationLanguage,
    text: string,
  ): Promise<string>;
  close(): void;
}

export type LocalStatus = {
  state: "idle" | "preparing" | "downloading" | "ready" | "failed";
  detail?: string;
};
