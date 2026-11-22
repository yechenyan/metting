import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureFailure,
  isCapturePermission,
  permissionPanes,
} from "../modules/speech/capture/permissions.ts";
import zh from "../modules/speech/capture/locales/zh-CN.json" with { type: "json" };
import { Journal } from "../modules/transcripts/journal.ts";

test("capture permission denials map to the matching macOS pane", () => {
  for (const code of [
    "systemAudioPermission",
    "microphonePermission",
  ] as const) {
    assert.deepEqual(captureFailure(code), { code });
    assert.equal(isCapturePermission(code), true);
  }
  assert.match(permissionPanes.systemAudioPermission, /Privacy_ScreenCapture$/);
  assert.match(permissionPanes.microphonePermission, /Privacy_Microphone$/);
  assert.deepEqual(captureFailure(null, "Microphone permission was denied."), {
    code: "microphonePermission",
  });
  assert.deepEqual(
    captureFailure(
      null,
      "User declined TCCs for application, window, display capture",
    ),
    { code: "systemAudioPermission" },
  );
  const detail = "No microphone is available.";
  assert.deepEqual(captureFailure(null, detail), {
    code: "captureError",
    detail,
  });
  assert.equal(isCapturePermission("constructor"), false);
});

test("an older meeting reopens with an actionable system audio notice", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meeting-capture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = new Journal(directory);
  old.setState("idle", {
    code: "captureError",
    detail: zh.legacySystemAudioDenial,
  });
  await old.flush();
  assert.deepEqual(new Journal(directory).snapshot().notice, {
    code: "systemAudioPermission",
  });
});
