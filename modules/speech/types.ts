export const languages = ["de", "zh", "en"] as const;
export type Language = (typeof languages)[number];
export const defaultSourceLanguage: Language = "de";
export type Source = "system" | "mic";
export interface AudioInput {
  id: string;
  name: string;
  channels: string[];
}
export interface InputCatalog {
  defaultId: string;
  devices: AudioInput[];
  applications: { id: string; name: string }[];
}
export interface SpeakerSpan {
  start: number;
  end: number;
  speaker: string;
  overlap?: boolean;
}
export interface SpeechInfo {
  ready: boolean;
  missing: string[];
}
