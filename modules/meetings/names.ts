import messages from "../../apps/web/locales/zh-CN.json";

export function defaultRecordingName(number: number) {
  return messages.meeting + " " + String(number).padStart(2, "0");
}

export function recordingStem(project: string, recording: string) {
  return project + " - " + recording;
}
