import {
  promises as fs,
  existsSync,
  mkdirSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { emptyUsage, type Usage } from "../agent-runtime/types.ts";
import {
  chronological,
  type Change,
  type Segment,
  type Snapshot,
} from "./types.ts";
import { type Notice, type RunState } from "../meetings/types.ts";
import { captureFailure } from "../speech/capture/permissions.ts";
import { retainRecognition } from "./recognition.ts";
import { draftScope, retainDraft } from "./drafts.ts";
import { ReadingLayout, turnStart, turnTranslation } from "./reading.ts";
import {
  defaultTranslationLanguage,
  draftText,
  translatedText,
  type TranslationTarget,
} from "./translation.ts";

export type Packet = { seq: number; change: Change };
export class Journal {
  readonly epoch = crypto.randomUUID();
  private recent: (Packet | undefined)[] = new Array(512);
  readonly rows = new Map<string, Segment>();
  readonly reading = new ReadingLayout();
  readonly names: Record<string, string> = Object.create(null);
  readonly listeners = new Set<(p: Packet) => void>();
  readonly path: string;
  readonly markdown: string;
  state: RunState = "idle";
  notice: Notice | null = null;
  aiStatus = "idle";
  usage = emptyUsage();
  seq = 0;
  rawCursor = 0;
  private rawVersions = new Map<string, number>();
  private speakerVersions = new Map<string, number>();
  private elapsed = 0;
  private started = 0;
  private latestPartial = new Map<string, Packet>();
  private queue: Packet[] = [];
  private timer?: NodeJS.Timeout;
  private partialTimer?: NodeJS.Timeout;
  private writing?: Promise<void>;
  private exporting = Promise.resolve();
  private committedBytes = 0;
  private diskFailed = false;

  constructor(
    public directory: string,
    private getTarget?: () => TranslationTarget,
  ) {
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, "transcript.jsonl");
    this.markdown = join(directory, "transcript.md");
    if (!existsSync(this.path)) writeFileSync(this.path, "", { mode: 0o600 });
    const bytes = readFileSync(this.path);
    const end = bytes.lastIndexOf(10) + 1;
    if (end < bytes.length) truncateSync(this.path, end);
    this.committedBytes = end;
    for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
      if (!line) continue;
      const p: Packet = JSON.parse(line);
      this.apply(p.change, p.seq);
      this.seq = Math.max(this.seq, p.seq);
    }
    if (this.notice?.code === "captureError")
      this.notice = captureFailure(this.notice.code, this.notice.detail);
    if (this.state !== "idle" && this.state !== "interrupted") {
      for (const row of this.rows.values()) {
        this.elapsed = Math.max(this.elapsed, row.end);
        if (row.stage === "partial" || row.stage === "stream")
          this.emit({
            kind: "segment",
            segment: { ...row, stage: "interrupted" },
          });
      }
      this.setState("interrupted", { code: "recovered" }, this.elapsed);
    }
    if (this.aiStatus === "working" || this.aiStatus === "queued")
      this.emit({ kind: "ai", status: "pending" });
  }
  rawChangedAt(row: Segment) {
    return Math.max(
      this.rawVersions.get(row.id) ?? 0,
      this.speakerVersions.get(row.speaker) ?? 0,
    );
  }
  private storeSegment(row: Segment, seq: number) {
    const before = this.rows.get(row.id);
    const saved = retainDraft(retainRecognition(row, this.rows), before);
    if (
      !before ||
      before.raw !== saved.raw ||
      before.start !== saved.start ||
      before.end !== saved.end ||
      before.speaker !== saved.speaker
    ) {
      this.rawVersions.set(saved.id, seq);
      this.rawCursor = Math.max(this.rawCursor, seq);
    }
    this.reading.changedSource(before, saved);
    this.rows.set(saved.id, saved);
    return saved;
  }
  private apply(c: Change, seq: number): Change {
    switch (c.kind) {
      case "segment": {
        const saved = this.storeSegment(c.segment, seq);
        return saved === c.segment ? c : { kind: "segment", segment: saved };
      }
      case "revision": {
        const segments = c.segments.map((row) => this.storeSegment(row, seq));
        if (c.plan) this.reading.replace(c.plan);
        return { ...c, segments };
      }
      case "remove":
        this.reading.remove(c.id);
        if (this.rows.delete(c.id)) {
          this.rawVersions.delete(c.id);
          this.rawCursor = Math.max(this.rawCursor, seq);
        }
        break;
      case "speaker":
        if (this.names[c.id] !== c.name) {
          this.speakerVersions.set(c.id, seq);
          this.rawCursor = Math.max(this.rawCursor, seq);
        }
        this.names[c.id] = c.name;
        break;
      case "usage":
        this.usage = c.usage;
        break;
      case "ai":
        this.aiStatus = c.status;
        break;
      case "notice":
        this.notice = c.notice;
        break;
      case "state":
        this.state = c.state;
        this.elapsed = c.elapsed;
        this.notice = c.notice;
        break;
    }
    return c;
  }
  time() {
    return this.elapsed + (this.started ? Date.now() - this.started : 0);
  }
  snapshot(): Snapshot {
    return {
      segments: [...this.rows.values()].sort(chronological),
      reading: this.reading.snapshot(),
      speakers: this.names,
      usage: this.usage,
      state: this.state,
      elapsed: this.time(),
      notice: this.notice,
      aiStatus: this.aiStatus,
      seq: this.seq,
    };
  }
  setState(
    state: RunState,
    notice: Notice | null = null,
    elapsed = this.time(),
  ) {
    this.started = state === "recording" ? Date.now() : 0;
    this.emit({ kind: "state", state, elapsed, notice });
  }
  since(epoch: string | null, seq: number): Packet[] | null {
    if (
      epoch !== this.epoch ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      seq > this.seq ||
      this.seq - seq > this.recent.length
    )
      return null;
    const packets: Packet[] = [];
    for (let n = seq + 1; n <= this.seq; n++) {
      const entry = this.recent[n % this.recent.length];
      if (entry?.seq !== n) return null;
      packets.push(entry);
    }
    return packets;
  }
  emit(change: Change) {
    const seq = ++this.seq;
    const packet = { seq, change: this.apply(change, seq) };
    this.recent[packet.seq % this.recent.length] = packet;
    if (change.kind === "segment" && change.segment.stage === "partial") {
      this.latestPartial.set(change.segment.id, packet);
      this.partialTimer ??= setTimeout(() => {
        this.partialTimer = undefined;
        this.commitPartials();
        this.schedule();
      }, 500);
    } else {
      if (change.kind === "segment" || change.kind === "remove")
        this.latestPartial.delete(
          change.kind === "segment" ? change.segment.id : change.id,
        );
      this.commitPartials();
      this.queue.push(packet);
      this.schedule();
    }
    for (const listener of this.listeners) listener(packet);
  }
  private commitPartials() {
    this.queue.push(
      ...[...this.latestPartial.values()].sort((a, b) => a.seq - b.seq),
    );
    this.latestPartial.clear();
  }
  private schedule() {
    this.timer ??= setTimeout(
      () => {
        this.timer = undefined;
        void this.flush().catch(() => {});
      },
      this.diskFailed ? 1500 : 45,
    );
    this.timer.unref();
  }
  async flush() {
    this.commitPartials();
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.writing && this.queue.length)
      this.writing = this.writeQueued().finally(() => {
        this.writing = undefined;
        if (this.queue.length) this.schedule();
      });
    await this.writing;
  }
  private async writeQueued() {
    while (this.queue.length) {
      const count = this.queue.length;
      const block = Buffer.from(
        this.queue
          .slice(0, count)
          .map((p) => JSON.stringify(p))
          .join("\n") + "\n",
      );
      try {
        const file = await fs.open(this.path, "r+");
        try {
          let offset = 0;
          while (offset < block.length) {
            const { bytesWritten } = await file.write(
              block,
              offset,
              block.length - offset,
              this.committedBytes + offset,
            );
            if (!bytesWritten)
              throw new Error("No transcript bytes were written");
            offset += bytesWritten;
          }
        } finally {
          await file.close();
        }
        this.committedBytes += block.length;
        this.queue.splice(0, count);
        if (this.diskFailed) {
          this.diskFailed = false;
          if (this.notice?.code === "storageError")
            this.emit({ kind: "notice", notice: null });
        }
      } catch (error) {
        if (!this.diskFailed) {
          this.diskFailed = true;
          this.notice = { code: "storageError", detail: String(error) };
          for (const listener of this.listeners)
            listener({
              seq: ++this.seq,
              change: { kind: "notice", notice: this.notice },
            });
        }
        throw error;
      }
    }
  }
  addUsage(run: Usage) {
    const result = { ...run };
    for (const k of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "total",
      "requests",
    ] as const)
      result[k] += this.usage[k];
    this.emit({ kind: "usage", usage: result });
  }
  export() {
    this.exporting = this.exporting
      .catch(() => {})
      .then(() => this.writeMarkdown());
    return this.exporting;
  }
  private async writeMarkdown() {
    await this.flush();
    const lines = ["# Meeting transcript", ""];
    const time = (ms: number) => new Date(ms).toISOString().slice(11, 19);
    const ids = this.snapshot().segments.map((s) => s.id);
    const selectedTarget = this.getTarget?.();
    for (const id of this.reading.order(ids)) {
      const s = this.rows.get(id)!;
      const turn = this.reading.turn(id);
      const name = this.names[s.speaker] || s.speaker;
      lines.push(
        "## " + time(turnStart(s, turn, this.rows)) + " · " + name,
        "",
        turn?.text || s.edited || s.raw,
        "",
      );
      if (turn && turn.ids.length > 1) {
        for (const key of turn.ids) {
          const source = this.rows.get(key)!;
          lines.push("> " + time(source.start) + " · " + source.raw, "");
        }
      } else if (s.edited && s.edited !== s.raw) lines.push("> " + s.raw, "");
      const target =
        selectedTarget === undefined
          ? (turn?.translationLanguage ??
            s.translationLanguage ??
            s.draftTranslation?.language ??
            defaultTranslationLanguage)
          : selectedTarget;
      const translation = turn
        ? turnTranslation(turn, this.rows, target)
        : translatedText(s, target);
      if (s.language !== target && translation) lines.push(translation, "");
      else if (
        s.language !== target &&
        (!turn || turn.ids.length === 1) &&
        draftText(s, target)
      ) {
        const scope = draftScope(s);
        const label =
          scope === "shared"
            ? "Draft translation before speaker split"
            : scope === "previous"
              ? "Previous draft translation"
              : "Draft translation";
        lines.push(label + ": " + draftText(s, target), "");
      }
      if (s.spans?.length && new Set(s.spans.map((p) => p.speaker)).size > 1) {
        for (const p of s.spans)
          lines.push(
            "- " +
              (this.names[p.speaker] || p.speaker) +
              " · " +
              (p.start / 1000).toFixed(1) +
              "–" +
              (p.end / 1000).toFixed(1) +
              "s",
          );
        lines.push("");
      }
    }
    const tmp = this.markdown + "." + crypto.randomUUID() + ".tmp";
    await fs.writeFile(tmp, lines.join("\n"), { mode: 0o600 });
    await fs.rename(tmp, this.markdown);
  }
}
