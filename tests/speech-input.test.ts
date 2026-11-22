import { test } from "node:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { speechPython } from "../modules/speech/paths.ts";
import { root } from "../shared/paths.mjs";

const run = promisify(execFile);

test(
  "only the selected source reaches both recognition stages",
  {
    skip:
      !existsSync(speechPython) &&
      "Install the speech runtime to run this test.",
  },
  async () => {
    await run(
      speechPython,
      [
        "-m",
        "unittest",
        "discover",
        "-s",
        "tests",
        "-p",
        "test_speech_input.py",
      ],
      { cwd: root, timeout: 30000 },
    );
  },
);

test(
  "native input selection isolates each hardware channel during PCM conversion",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "meeting-channels-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const binary = join(directory, "channel-test");
    await run(
      "xcrun",
      [
        "clang",
        "-fobjc-arc",
        "-fblocks",
        "tests/audio-channels.m",
        "modules/speech/capture/macos/AudioInputs.m",
        "-framework",
        "Foundation",
        "-framework",
        "AVFoundation",
        "-framework",
        "CoreAudio",
        "-o",
        binary,
      ],
      { cwd: root },
    );
    await run(binary);
  },
);
