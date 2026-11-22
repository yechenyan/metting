import type { Notice } from "../../meetings/types.ts";
import zh from "./locales/zh-CN.json" with { type: "json" };

export const permissionPanes = {
  systemAudioPermission:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  microphonePermission:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
} as const;

export function isCapturePermission(
  code: unknown,
): code is keyof typeof permissionPanes {
  return typeof code === "string" && Object.hasOwn(permissionPanes, code);
}

export function captureFailure(code: unknown, detail?: string): Notice {
  if (isCapturePermission(code)) return { code };
  if (
    code === "inputDeviceUnavailable" ||
    code === "inputChannelUnavailable" ||
    code === "inputDeviceChanged" ||
    code === "inputFormatUnavailable"
  )
    return { code, ...(detail ? { detail } : {}) };
  // Older capture helpers persisted the localized system message without its error code.
  const message = detail?.trim();
  if (
    message === zh.legacySystemAudioDenial ||
    /^(?:the )?user declined TCCs? for application,? window,? display capture\.?$/i.test(
      message || "",
    )
  )
    return { code: "systemAudioPermission" };
  if (message === "Microphone permission was denied.")
    return { code: "microphonePermission" };
  return { code: "captureError", detail };
}
