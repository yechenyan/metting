import { useCallback, useSyncExternalStore } from "react";
import { emptyAudio } from "../audio/timeline.ts";
import { emptyUsage } from "../agent-runtime/types.ts";
import {
  chronological,
  type Segment,
  type Snapshot,
  type Change,
  type ReadingPlan,
} from "./types.ts";
import { ReadingLayout } from "./reading.ts";
import { SpeakerNames } from "./speaker-names.ts";
import { retainDraft } from "./drafts.ts";
import {
  countSourceWords,
  wordsPerPreview,
} from "../local-translation/partials.ts";
import { type RunState, type Notice } from "../meetings/types.ts";
import type { LocalStatus } from "../local-translation/types.ts";
export class TranscriptClient {
  localTranslation: LocalStatus = { state: "idle" };
  audio = emptyAudio;
  ids: string[] = [];
  rows = new Map<string, Segment>();
  reading = new ReadingLayout();
  readingVersion = 0;
  speakerNames = new SpeakerNames();
  speakerVersion = 0;
  usage = emptyUsage();
  levels = [0, 0];
  runningTokens = 0;
  connected = false;
  loaded = false;
  state: {
    value: RunState;
    elapsed: number;
    at: number;
    notice: Notice | null;
  } = { value: "idle", elapsed: 0, at: Date.now(), notice: null };
  ai = "idle";
  private epoch = "";
  private serverPacesPreviews = false;
  private seq = 0;
  private signals = new Map<string, Set<() => void>>();
  private socket?: WebSocket;
  private retry?: number;
  private closed = false;
  constructor(public meeting: string) {}
  listen(key: string, cb: () => void) {
    let set = this.signals.get(key);
    if (!set) {
      set = new Set();
      this.signals.set(key, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (!set.size) this.signals.delete(key);
    };
  }
  private ping(...keys: string[]) {
    for (const key of keys) for (const cb of this.signals.get(key) || []) cb();
  }
  private receivedRow(row: Segment, previous?: Segment) {
    // A recording already in progress may still send previews at the older cadence.
    const next = row.draftTranslation;
    if (!this.serverPacesPreviews && row.stage === "partial" && next?.text) {
      const prior =
        previous?.language === row.language &&
        previous.draftTranslation?.language === next.language
          ? previous.draftTranslation
          : undefined;
      if (next.source !== prior?.source || next.text !== prior?.text) {
        const lastWords = prior
          ? countSourceWords(prior.source, row.language)
          : 0;
        if (
          countSourceWords(next.source, row.language) - lastWords <
          wordsPerPreview
        )
          return retainDraft({ ...row, draftTranslation: undefined }, previous);
      }
    }
    return retainDraft(row, previous);
  }
  private snapshot(s: Snapshot) {
    this.ids = s.segments.map((v) => v.id);
    this.rows = new Map(
      s.segments.map((row) => [
        row.id,
        this.receivedRow(row, this.rows.get(row.id)),
      ]),
    );
    this.reading = new ReadingLayout(s.reading);
    this.readingVersion++;
    this.speakerNames = new SpeakerNames(s.speakers, s.speakerAssignments);
    this.speakerVersion++;
    this.usage = s.usage;
    this.ai = s.aiStatus;
    this.runningTokens = 0;
    this.loaded = true;
    this.state = {
      value: s.state,
      elapsed: s.elapsed,
      at: Date.now(),
      notice: s.notice,
    };
    for (const key of this.signals.keys()) this.ping(key);
  }
  private storeRows(rows: Segment[], plan?: ReadingPlan) {
    const oldIds = this.ids;
    let layoutChanged = false;
    let namesChanged = false;
    for (const incoming of rows) {
      const previous = this.rows.get(incoming.id);
      const r = this.receivedRow(incoming, previous);
      if (this.reading.changedSource(previous, r)) layoutChanged = true;
      this.rows.set(r.id, r);
      const confirmed = this.speakerNames.confirm(r);
      if (confirmed) {
        this.speakerNames.apply([confirmed]);
        namesChanged = true;
      }
      if (!previous || previous.start !== r.start) {
        const ids = previous ? this.ids.filter((id) => id !== r.id) : this.ids;
        const last = this.rows.get(ids.at(-1) || "");
        if (!last || chronological(last, r) <= 0) this.ids = [...ids, r.id];
        else {
          const i = ids.findIndex(
            (id) => chronological(this.rows.get(id)!, r) > 0,
          );
          this.ids = [...ids.slice(0, i), r.id, ...ids.slice(i)];
        }
      }
    }
    if (plan && this.reading.replace(plan)) layoutChanged = true;
    if (namesChanged) {
      if (this.reading.separateSpeakers(this.rows, this.speakerNames))
        layoutChanged = true;
      this.speakerVersion++;
      this.ping("speakers");
    }
    if (layoutChanged) this.readingVersion++;
    if (this.ids !== oldIds) this.ping("ids");
    if (layoutChanged) this.ping("reading");
    for (const row of rows) this.ping(row.id);
  }
  private change(c: Change) {
    switch (c.kind) {
      case "segment":
        this.storeRows([c.segment]);
        break;
      case "revision":
        this.storeRows(c.segments, c.plan);
        break;
      case "remove": {
        const rearranged = this.reading.remove(c.id);
        this.rows.delete(c.id);
        this.ids = this.ids.filter((x) => x !== c.id);
        if (rearranged) {
          this.readingVersion++;
          this.ping("reading");
        }
        this.ping("ids", c.id);
        break;
      }
      case "speaker":
      case "speakerAssignment":
        if (c.kind === "speaker") this.speakerNames.legacy[c.id] = c.name;
        else this.speakerNames.apply(c.assignments);
        if (this.reading.separateSpeakers(this.rows, this.speakerNames)) {
          this.readingVersion++;
          this.ping("reading");
        }
        this.speakerVersion++;
        this.ping("speakers");
        break;
      case "state":
        this.state = {
          value: c.state,
          elapsed: c.elapsed,
          at: Date.now(),
          notice: c.notice,
        };
        this.ping("state");
        break;
      case "notice":
        this.state = { ...this.state, notice: c.notice };
        this.ping("state");
        break;
      case "usage":
        this.usage = c.usage;
        this.ping("usage");
        break;
      case "ai":
        this.ai = c.status;
        this.ping("ai");
        break;
    }
  }
  open() {
    this.closed = false;
    const connect = () => {
      if (this.closed) return;
      const url = new URL("/events", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("meeting", this.meeting);
      if (this.loaded) {
        url.searchParams.set("epoch", this.epoch);
        url.searchParams.set("since", String(this.seq));
      }
      const ws = (this.socket = new WebSocket(url));
      ws.onopen = () => {
        this.connected = true;
        this.ping("connection");
        if (this.loaded) window.dispatchEvent(new Event("meeting-reconnected"));
      };
      ws.onmessage = (event) => {
        if (this.closed) return;
        const p = JSON.parse(event.data);
        if (p.kind === "snapshot" || p.kind === "resume")
          this.serverPacesPreviews = p.previewWords >= wordsPerPreview;
        if (p.kind === "snapshot") {
          this.epoch = p.epoch;
          this.seq = p.value.seq;
          this.snapshot(p.value);
        } else if (p.kind === "resume") {
          for (const packet of p.packets) {
            this.change(packet.change);
            this.seq = packet.seq;
          }
        } else if (p.kind === "change") {
          this.seq = p.seq;
          this.change(p.change);
        } else if (p.kind === "audio") {
          if (p.value.version !== this.audio.version) {
            this.audio = p.value;
            this.ping("audio");
          }
        } else if (p.kind === "localTranslation") {
          this.localTranslation = p.value;
          this.ping("localTranslation");
        } else if (p.kind === "activity")
          window.dispatchEvent(
            new CustomEvent("meeting-activity", { detail: p.active }),
          );
        else if (p.kind === "projectChanged")
          window.dispatchEvent(new Event("meeting-project-changed"));
        else if (p.kind === "levels") {
          this.levels = p.levels;
          this.ping("levels");
        } else if (p.kind === "runningTokens") {
          this.runningTokens = p.tokens;
          this.ping("runningTokens");
        }
      };
      ws.onclose = () => {
        this.connected = false;
        this.ping("connection");
        if (!this.closed) this.retry = window.setTimeout(connect, 900);
      };
    };
    connect();
    return () => {
      this.closed = true;
      clearTimeout(this.retry);
      if (this.socket) {
        this.socket.onclose = null;
        this.socket.close();
      }
    };
  }
}
export function usePart<T>(
  client: TranscriptClient,
  key: string,
  read: () => T,
) {
  const subscribe = useCallback(
    (cb: () => void) => client.listen(key, cb),
    [client, key],
  );
  return useSyncExternalStore(subscribe, read);
}
