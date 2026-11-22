import type { Language, Source } from "../speech/types.ts";
import type { TranslationLanguage } from "../transcripts/translation.ts";
export type RunState =
  "idle" | "preparing" | "recording" | "stopping" | "interrupted";
export interface Settings {
  language: Language;
  source: Source;
  application: string;
  inputDevice: string;
  inputChannel: number;
  model: string;
  thinking: string;
  editing: boolean;
  translate: boolean;
  localTranslation?: boolean;
  translationLanguage: TranslationLanguage;
}
export interface Meeting {
  id: string;
  name: string;
  directoryName: string;
  projectDirectoryName?: string;
  pendingDirectoryName?: string;
  created: string;
  storageFolder: string;
  settings: Settings;
}
export interface Notice {
  code: string;
  detail?: string;
}
