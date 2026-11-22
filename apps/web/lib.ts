import type { AgentInfo } from "../../modules/agent-runtime/types";
import type { SpeechInfo } from "../../modules/speech/types";
import type { Segment } from "../../modules/transcripts/types";
import type { SpeakerNames } from "../../modules/transcripts/speaker-names";
export interface Runtime {
  pi: AgentInfo;
  speech: SpeechInfo;
}
import t from "./locales/zh-CN.json";
export { t };
export function recordingName(number: number) {
  return t.meeting + " " + String(number).padStart(2, "0");
}
export async function api<T>(
  path: string,
  value?: unknown,
  method = "POST",
): Promise<T> {
  return requestJson<T>("/api/" + path, value, method);
}
export async function requestJson<T>(
  url: string,
  value?: unknown,
  method = "POST",
): Promise<T> {
  const res = await fetch(
    url,
    value === undefined
      ? {}
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}
export function clock(ms: number, full = false) {
  const s = Math.max(0, Math.floor(ms / 1000)),
    parts = [Math.floor(s / 60) % 60, s % 60];
  if (full || s >= 3600) parts.unshift(Math.floor(s / 3600));
  return parts.map((n) => String(n).padStart(2, "0")).join(":");
}
export function nameOf(
  row: Segment,
  names: SpeakerNames,
  speaker = row.speaker,
) {
  return (
    names.name(row, speaker) ||
    (speaker === "unknown" ? t.unknown : t.speaker + " " + speaker.slice(1))
  );
}
