import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { defaultThread, type ChatThread } from "./types.ts";

export class UnknownThread extends Error {}

export class ChatThreads {
  private file: string;
  constructor(private recording: string) {
    this.file = join(recording, "chats.json");
  }
  list(): ChatThread[] {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [{ id: defaultThread, title: "" }];
    }
  }
  private save(threads: ChatThread[]) {
    const temp = this.file + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temp, JSON.stringify(threads), { flag: "wx", mode: 0o600 });
      renameSync(temp, this.file);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  create(id: string) {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id))
      throw new Error("Invalid conversation ID");
    const threads = this.list();
    if (!threads.some((thread) => thread.id === id)) {
      mkdirSync(join(this.recording, "chats", id), {
        recursive: true,
        mode: 0o700,
      });
      threads.push({ id, title: "" });
      this.save(threads);
    }
    return threads;
  }
  directory(id: string) {
    if (id === defaultThread) return this.recording;
    if (!this.list().some((thread) => thread.id === id))
      throw new UnknownThread("Unknown conversation");
    return join(this.recording, "chats", id);
  }
  name(id: string, title: string) {
    if (id === defaultThread) return;
    const threads = this.list();
    const thread = threads.find((entry) => entry.id === id);
    if (thread && !thread.title) {
      thread.title = Array.from(title.trim().replace(/\s+/g, " "))
        .slice(0, 48)
        .join("");
      this.save(threads);
    }
  }
}
