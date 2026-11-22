import type { Meeting } from "../meetings/types.ts";
import type { Journal } from "../transcripts/journal.ts";
import type { Segment } from "../transcripts/types.ts";
import {
  draftText,
  translatedText,
  translationTarget,
  type TranslationLanguage,
} from "../transcripts/translation.ts";
import type { LocalTranslator, LocalStatus } from "./types.ts";
import { M2m100 } from "./m2m100.ts";
import { keepsPrefix } from "../transcripts/drafts.ts";
import { countSourceWords, wordsPerPreview } from "./partials.ts";

type Request = {
  meeting: Meeting;
  journal: Journal;
  row: Segment;
  target: TranslationLanguage;
  cancelled?: boolean;
};
const key = (request: Request) => request.meeting.id + "/" + request.row.id;
function valid(
  { meeting, journal, row, target, cancelled }: Request,
  publishing = false,
) {
  const current = journal.rows.get(row.id);
  if (
    cancelled ||
    !current ||
    meeting.settings.localTranslation === false ||
    translationTarget(meeting.settings) !== target ||
    current.language !== row.language ||
    current.start !== row.start ||
    translatedText(current, target)
  )
    return false;
  const prior = draftText(current, target)
    ? current.draftTranslation?.source
    : undefined;
  if (prior === current.raw || prior === row.raw) return false;
  if (row.stage === "partial") {
    if (current.end < row.end || current.stage === "interrupted") return false;
    if (current.stage !== "partial")
      return publishing && current.raw === row.raw;
    if (journal.state !== "preparing" && journal.state !== "recording")
      return false;
    return publishing
      ? keepsPrefix(current.raw, row.raw, row.language)
      : current.raw === row.raw;
  }
  return (
    (current.stage === "stream" || current.stage === "final") &&
    current.raw === row.raw &&
    current.end === row.end
  );
}

export class DraftTranslations {
  status: LocalStatus = { state: "idle" };
  private worker?: LocalTranslator;
  private pending = new Map<string, Request>();
  // Capture has one live utterance. Completed sentences keep their own work queue.
  private partial?: { request: Request; words: number };
  private lastPartial?: {
    meeting: string;
    id: string;
    target: TranslationLanguage;
    words: number;
  };
  private lastWasPartial = false;
  private active?: Request;
  private closed = false;
  private finished = new Set<Journal>();
  constructor(
    private publish: (status: LocalStatus) => void,
    private create: (download: () => void) => LocalTranslator = (download) =>
      new M2m100(download),
  ) {}

  private state(status: LocalStatus) {
    this.status = status;
    this.publish(status);
  }
  prepare(meeting: Meeting, retry = false) {
    const target = translationTarget(meeting.settings);
    if (
      this.closed ||
      !target ||
      target === meeting.settings.language ||
      meeting.settings.localTranslation === false
    )
      return;
    if (this.worker || (this.status.state === "failed" && !retry)) return;
    const worker = (this.worker = this.create(() => {
      if (this.worker === worker) this.state({ state: "downloading" });
    }));
    this.state({ state: "preparing" });
    void worker
      .prepare()
      .then(() => {
        if (this.worker !== worker) return;
        this.state({ state: "ready" });
        this.pump();
      })
      .catch((error) => this.failed(worker, error));
  }
  private failed(worker: LocalTranslator, error: unknown) {
    if (this.worker !== worker) return;
    this.worker = undefined;
    worker.close();
    this.state({
      state: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  offer(meeting: Meeting, journal: Journal, row: Segment) {
    const target = translationTarget(meeting.settings);
    if (row.stage !== "partial") this.finishPartial(meeting.id, row.id);
    if (
      this.closed ||
      !target ||
      target === row.language ||
      !row.raw.trim() ||
      row.stage === "interrupted"
    )
      return;
    const request = { meeting, journal, row, target };
    if (row.stage === "partial") {
      const previous = this.lastPartial;
      const lastWords =
        previous?.meeting === meeting.id &&
        previous.id === row.id &&
        previous.target === target
          ? previous.words
          : 0;
      const words = valid(request)
        ? countSourceWords(row.raw, row.language)
        : 0;
      this.partial =
        words - lastWords >= wordsPerPreview ? { request, words } : undefined;
      if (!this.partial) return;
    } else {
      if (!valid(request)) return;
      this.pending.set(key(request), request);
    }
    this.prepare(meeting);
    this.pump();
  }
  finishPartial(meeting: string, id?: string) {
    if (
      this.partial?.request.meeting.id === meeting &&
      (!id || this.partial.request.row.id === id)
    ) {
      this.partial = undefined;
    }
    if (
      this.lastPartial?.meeting === meeting &&
      (!id || this.lastPartial.id === id)
    )
      this.lastPartial = undefined;
    // An identical endpoint can reuse its in-flight inference until capture stops.
    if (
      !id &&
      this.active?.row.stage === "partial" &&
      this.active.meeting.id === meeting
    )
      this.active.cancelled = true;
  }
  cancel(id: string) {
    this.finishPartial(id);
    for (const [k, r] of this.pending)
      if (r.meeting.id === id) this.pending.delete(k);
    if (this.active?.meeting.id === id) this.active.cancelled = true;
  }
  private next(): Request | undefined {
    if (this.partial && !valid(this.partial.request)) this.partial = undefined;
    const live = this.partial;
    // Under load, alternate ready previews and settled sentences.
    if (live && (!this.lastWasPartial || !this.pending.size)) {
      const { request } = live;
      this.partial = undefined;
      this.lastWasPartial = true;
      this.lastPartial = {
        meeting: request.meeting.id,
        id: request.row.id,
        target: request.target,
        words: live.words,
      };
      return request;
    }
    const head = this.pending.entries().next();
    if (!head.done) {
      const [id, request] = head.value;
      this.pending.delete(id);
      this.lastWasPartial = false;
      return request;
    }
  }
  private pump() {
    if (this.active) return;
    const worker = this.worker;
    const next =
      worker && !this.closed && this.status.state === "ready"
        ? this.next()
        : undefined;
    if (next && worker) {
      this.active = next;
      void this.translate(worker, next).finally(() => {
        this.active = undefined;
        this.pump();
      });
      return;
    }
    for (const journal of this.finished) {
      void journal.export().catch((error) =>
        journal.emit({
          kind: "notice",
          notice: { code: "storageError", detail: String(error) },
        }),
      );
    }
    this.finished.clear();
  }
  private async translate(worker: LocalTranslator, request: Request) {
    if (!valid(request)) return;
    const { journal, row, target } = request;
    try {
      const text = await worker.translate(row.language, target, row.raw);
      if (!text || !valid(request, true)) return;
      const current = journal.rows.get(row.id)!;
      journal.emit({
        kind: "segment",
        segment: {
          ...current,
          draftTranslation: { language: target, text, source: row.raw },
        },
      });
      if (journal.state === "idle") this.finished.add(journal);
    } catch (error) {
      if (valid(request)) {
        if (row.stage === "partial")
          this.partial ??= {
            request,
            words: countSourceWords(row.raw, row.language),
          };
        else if (!this.pending.has(key(request)))
          this.pending.set(key(request), request);
      }
      this.failed(worker, error);
    }
  }
  close() {
    this.closed = true;
    this.partial = undefined;
    if (this.active) this.active.cancelled = true;
    this.pending.clear();
    this.worker?.close();
    this.worker = undefined;
  }
}
