import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { cacheDir, root } from "../../shared/paths.mjs";
import { captureBinary, speechPython } from "./paths.ts";
import { captureFailure } from "./capture/permissions.ts";
import { defaultSourceLanguage, type Language } from "./types.ts";
import type { Notice, Settings } from "../meetings/types.ts";
import type { Segment } from "../transcripts/types.ts";

const catalog: Record<Language, string> = {
  zh: "vosk-model-small-cn-0.22",
  en: "vosk-model-small-en-us-0.15",
  de: "vosk-model-small-de-0.15",
};
export function speechInfo(language: Language = defaultSourceLanguage) {
  const models = join(cacheDir, "models");
  const required: Record<string, string> = {
    capture: captureBinary,
    python: speechPython,
    stream: join(models, catalog[language], "am", "final.mdl"),
    final: join(models, "ggml-small-q5_1.bin"),
    voices: join(models, "nemo_en_titanet_small.onnx"),
    segmentation: join(
      models,
      "sherpa-onnx-pyannote-segmentation-3-0",
      "model.int8.onnx",
    ),
  };
  const missing = Object.keys(required).filter((k) => !existsSync(required[k]));
  return { ready: !missing.length, missing };
}
export interface SpeechCallbacks {
  ready(): void;
  segment(row: Segment): void;
  speakers(id: string, speaker: string, spans: Segment["spans"]): void;
  levels(values: number[]): void;
  warning(notice: Notice): void;
  end(failure: Notice | null): void;
}
export type SpeechSession = Pick<
  LocalSpeech,
  "prepare" | "startCapture" | "stop" | "force"
>;
export function createLocalSpeech(
  language: Language,
  callbacks: SpeechCallbacks,
): SpeechSession | undefined {
  if (speechInfo(language).ready) return new LocalSpeech(callbacks);
}
export class LocalSpeech {
  private worker?: ChildProcessWithoutNullStreams;
  private capture?: ChildProcessWithoutNullStreams;
  private closing = false;
  private ended = false;
  private failure: Notice | null = null;
  private fence?: NodeJS.Timeout;
  constructor(private c: SpeechCallbacks) {}
  prepare(settings: Settings, directory: string, offset: number) {
    const worker = (this.worker = spawn(
      speechPython,
      [
        "-u",
        join(root, "modules/speech/worker.py"),
        "--models",
        join(cacheDir, "models"),
        "--profile",
        join(directory, "voices.json"),
        "--audio-dir",
        join(directory, "audio"),
        "--language",
        settings.language,
        "--offset",
        String(Math.round(offset)),
      ],
      {
        stdio: "pipe",
        detached: true,
        env: {
          ...process.env,
          OMP_NUM_THREADS: "2",
          OPENBLAS_NUM_THREADS: "1",
          VECLIB_MAXIMUM_THREADS: "2",
        },
      },
    ));
    let diagnostics = "";
    worker.stderr.setEncoding("utf8").on("data", (s) => {
      diagnostics = (diagnostics + s).slice(-2200);
    });
    worker.stdin.on("error", () => {});
    worker.on("error", (error) =>
      this.finish({ code: "speechError", detail: error.message }),
    );
    worker.on("close", (code) => {
      if (!this.closing && !this.failure)
        this.failure = {
          code: "speechError",
          detail: diagnostics.trim() || "Speech worker stopped unexpectedly",
        };
      if (code && !this.failure)
        this.failure = { code: "speechError", detail: diagnostics.trim() };
      this.finish(this.failure);
    });
    createInterface({ input: worker.stdout }).on("line", (line) => {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.kind === "segment") this.c.segment(e.segment);
      else if (e.kind === "speakers") this.c.speakers(e.id, e.speaker, e.spans);
      else if (e.kind === "levels") this.c.levels(e.levels);
      else if (e.kind === "warning") {
        const notice = { code: e.code, detail: e.detail };
        if (e.code === "audioStorageError") this.failure ??= notice;
        this.c.warning(notice);
      }
    });
  }
  startCapture(settings: Settings) {
    const proc = (this.capture = spawn(
      captureBinary,
      settings.source === "system"
        ? ["system", settings.application]
        : ["mic", settings.inputDevice, String(settings.inputChannel)],
      { stdio: "pipe" },
    ));
    const input = this.worker!.stdin;
    input.write(Buffer.from([settings.source === "system" ? 0 : 1]));
    proc.stdout.pipe(input);
    proc.on("error", (e) =>
      this.abort({ code: "captureError", detail: e.message }),
    );
    createInterface({ input: proc.stderr }).on("line", (line) => {
      try {
        const e = JSON.parse(line);
        if (e.event === "ready" && !this.closing) this.c.ready();
        if (e.event === "error") this.abort(captureFailure(e.code, e.detail));
      } catch {
        /* Native diagnostics can contain non-protocol lines. */
      }
    });
    proc.on("close", () => {
      if (!this.closing)
        this.abort({
          code: "captureError",
          detail: "The capture device disconnected.",
        });
    });
  }
  private abort(notice: Notice) {
    this.failure = notice;
    this.c.warning(notice);
    this.stop();
  }
  stop() {
    if (this.closing || this.ended) return;
    this.closing = true;
    if (this.capture) this.capture.kill("SIGTERM");
    else this.worker?.stdin.end();
    this.fence = setTimeout(() => {
      this.killGroup();
      this.finish(this.failure || { code: "drainTimeout" });
    }, 75000);
  }
  private killGroup() {
    if (this.worker?.pid) {
      try {
        process.kill(-this.worker.pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
    }
  }
  force() {
    this.closing = true;
    this.capture?.kill();
    this.killGroup();
    this.finish(this.failure);
  }
  private finish(failure: Notice | null) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.fence);
    this.capture?.kill();
    this.killGroup();
    this.c.end(failure);
  }
}
