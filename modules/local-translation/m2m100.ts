import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { root, cacheDir } from "../../shared/paths.mjs";
import { speechPython } from "../speech/paths.ts";
import type { Language } from "../speech/types.ts";
import type { TranslationLanguage } from "../transcripts/translation.ts";
import type { LocalTranslator } from "./types.ts";

export class M2m100 implements LocalTranslator {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 0;
  private response?: {
    id: number;
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  };
  constructor(private downloading: () => void) {}

  prepare() {
    return (this.ready ??= new Promise<void>((resolve, reject) => {
      const child = (this.child = spawn(
        speechPython,
        [
          "-u",
          join(root, "modules/local-translation/worker.py"),
          join(cacheDir, "translation"),
        ],
        {
          stdio: "pipe",
          env: {
            ...process.env,
            PYTHONDONTWRITEBYTECODE: "1",
            OMP_NUM_THREADS: "2",
            OPENBLAS_NUM_THREADS: "1",
            VECLIB_MAXIMUM_THREADS: "2",
          },
        },
      ));
      let diagnostic = "";
      const fail = (error: Error) => {
        reject(error);
        this.response?.reject(error);
        this.response = undefined;
        if (this.child === child) this.child = undefined;
        child.kill();
      };
      child.stderr.setEncoding("utf8").on("data", (s) => {
        diagnostic = (diagnostic + s).slice(-600);
      });
      child.stdin.on("error", fail);
      child.once("error", fail);
      child.once("close", () =>
        fail(
          new Error(diagnostic.trim() || "Local translation worker stopped"),
        ),
      );
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.kind === "ready") resolve();
          else if (event.kind === "downloading") this.downloading();
          else if (event.kind === "failed") fail(new Error(event.detail));
          else if (this.response && this.response.id === event.id) {
            const current = this.response;
            this.response = undefined;
            if (event.kind === "result" && typeof event.text === "string")
              current.resolve(event.text);
            else
              current.reject(
                new Error(event.detail || "Invalid local translation response"),
              );
          }
        } catch {
          fail(new Error("Invalid local translation protocol"));
        }
      });
    }));
  }

  async translate(source: Language, target: TranslationLanguage, text: string) {
    await this.prepare();
    const child = this.child;
    if (!child || this.response)
      throw new Error("Local translator is unavailable");
    const id = ++this.nextId;
    const timer = setTimeout(() => child.kill(), 45_000);
    try {
      return await new Promise<string>((resolve, reject) => {
        this.response = { id, resolve, reject };
        child.stdin.write(JSON.stringify({ id, source, target, text }) + "\n");
      });
    } finally {
      clearTimeout(timer);
    }
  }
  close() {
    this.child?.kill();
  }
}
