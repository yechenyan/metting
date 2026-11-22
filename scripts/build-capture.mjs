import { copyFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
if (process.platform !== "darwin")
  throw new Error("Meeting audio capture requires macOS 15 or newer.");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "modules/speech/capture/macos");
const app = join(root, ".runtime/MeetingDeskCapture.app");
const bin = join(app, "Contents/MacOS/MeetingDeskCapture");
const sources = ["Capture.m", "AudioInputs.m", "DeviceInput.m"].map((name) =>
    join(src, name),
  ),
  plist = join(src, "Info.plist");
if (
  !existsSync(bin) ||
  [
    ...sources,
    join(src, "AudioInputs.h"),
    join(src, "DeviceInput.h"),
    plist,
  ].some((p) => statSync(p).mtimeMs > statSync(bin).mtimeMs)
) {
  mkdirSync(dirname(bin), { recursive: true });
  copyFileSync(plist, join(app, "Contents/Info.plist"));
  execFileSync(
    "xcrun",
    [
      "clang",
      "-fobjc-arc",
      "-fblocks",
      "-O2",
      "-mmacosx-version-min=15.0",
      ...sources,
      "-framework",
      "AppKit",
      "-framework",
      "AVFoundation",
      "-framework",
      "CoreAudio",
      "-framework",
      "AudioToolbox",
      "-framework",
      "ScreenCaptureKit",
      "-framework",
      "CoreMedia",
      "-o",
      bin,
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "codesign",
    [
      "--force",
      "--sign",
      "-",
      "--identifier",
      "local.meetingdesk.capture",
      app,
    ],
    { stdio: "inherit" },
  );
}
