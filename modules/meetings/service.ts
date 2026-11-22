import { Projects } from "../projects/repository.ts";
import type { Project } from "../projects/types.ts";
import { millisecondsPerMinute } from "../projects/recording-limit.ts";
import { Editor } from "../ai-editing/editor.ts";
import { Journal } from "../transcripts/journal.ts";
import { createLocalSpeech, type SpeechSession } from "../speech/local.ts";
import type { Notice } from "./types.ts";
import type { Segment } from "../transcripts/types.ts";
import type { Language } from "../speech/types.ts";
import { translationTarget } from "../transcripts/translation.ts";
import {
  audioManifest,
  readAudioParts,
  type AudioPart,
} from "../audio/archive.ts";
import { framesPerMs } from "../audio/timeline.ts";
import type { DraftTranslations } from "../local-translation/service.ts";
const limitNotice: Notice = { code: "recordingLimitReached" };

function remainingTime(project: Project, journal: Journal) {
  return project.maxRecordingMinutes * millisecondsPerMinute - journal.time();
}

export class Meetings {
  private records = new Map<string, { journal: Journal; audio: AudioPart[] }>();
  private warm?: {
    id: string;
    language: Language;
    speech: SpeechSession;
  };
  private current?: {
    id: string;
    project: Project;
    journal: Journal;
    speech: SpeechSession;
    limitReached: boolean;
    timer?: NodeJS.Timeout;
  };
  constructor(
    public projects: Projects,
    public editor: Editor,
    private transient: (id: string, event: object) => void,
    private activity: (id: string | null) => void,
    private createSpeech = createLocalSpeech,
    private drafts?: DraftTranslations,
  ) {}
  get active() {
    return this.current?.id || null;
  }
  private refreshAudio(record: { journal: Journal; audio: AudioPart[] }) {
    try {
      record.audio = readAudioParts(record.journal.directory);
    } catch (error) {
      return { code: "audioStorageError", detail: String(error) };
    }
  }
  private audioEnd(parts: AudioPart[]) {
    return parts.reduce(
      (end, p) => Math.max(end, Math.ceil(p.start + p.frames / framesPerMs)),
      0,
    );
  }
  record(id: string) {
    let record = this.records.get(id);
    if (!record) {
      const { project, meeting } = this.projects.find(id);
      const journal = new Journal(
        this.projects.directory(project, meeting),
        () => translationTarget(meeting.settings),
      );
      record = { journal, audio: [] };
      const warning = this.refreshAudio(record);
      const end = this.audioEnd(record.audio);
      if (end > journal.time())
        journal.setState(journal.state, journal.notice, end);
      if (warning) journal.emit({ kind: "notice", notice: warning });
      this.records.set(id, record);
    }
    return record;
  }
  journal(id: string) {
    return this.record(id).journal;
  }
  prepare(id: string) {
    const { project, meeting } = this.projects.find(id);
    if (this.current && this.current.id !== id) return;
    const j = this.journal(id);
    if (this.current?.limitReached || remainingTime(project, j) <= 0) return;
    this.drafts?.prepare(meeting);
    if (this.current) return;
    const { language } = meeting.settings;
    if (this.warm?.id === id && this.warm.language === language) return;
    this.warm?.speech.force();
    this.warm = undefined;
    const speech: SpeechSession | undefined = this.createSpeech(language, {
      ready: () => {
        if (this.current?.speech !== speech || j.state !== "preparing") return;
        j.setState("recording");
        this.scheduleLimit();
        this.enqueueEditing(id, true);
      },
      warning: (notice) => {
        if (!this.current?.limitReached) j.emit({ kind: "notice", notice });
      },
      levels: (levels) => this.transient(id, { kind: "levels", levels }),
      segment: (row: Segment) => {
        const previous = j.rows.get(row.id);
        if (previous?.stage === "final" && row.stage !== "final") return;
        const next = {
          ...row,
          revision: row.stage === "final" ? (previous?.revision || 0) + 1 : 0,
        };
        j.emit({ kind: "segment", segment: next });
        if (
          this.current?.speech === speech &&
          !this.current?.limitReached &&
          (row.stage !== "partial" || j.state !== "stopping")
        )
          this.drafts?.offer(meeting, j, next);
        if (
          row.stage === "final" &&
          this.current &&
          this.current.speech === speech
        ) {
          if (remainingTime(project, j) <= 0) this.stop(id);
          else if (!this.current.limitReached) this.editor.enqueue(meeting, j);
        }
      },
      speakers: (key, speaker, spans) => {
        const row = j.rows.get(key);
        if (row)
          j.emit({ kind: "segment", segment: { ...row, speaker, spans } });
      },
      end: (failure: Notice | null) => {
        if (this.warm?.speech === speech) this.warm = undefined;
        const current = this.current;
        if (!current || current.speech !== speech) return;
        this.drafts?.finishPartial(id);
        clearTimeout(current.timer);
        const record = this.record(id);
        const audioError = this.refreshAudio(record);
        let elapsed = Math.max(j.time(), this.audioEnd(record.audio));
        for (const row of j.rows.values()) elapsed = Math.max(elapsed, row.end);
        if (
          !current.limitReached &&
          elapsed >= project.maxRecordingMinutes * millisecondsPerMinute
        ) {
          current.limitReached = true;
          this.drafts?.cancel(id);
          this.editor.suspend(id, j);
        }
        this.current = undefined;
        this.activity(null);
        const stopNotice =
          current.limitReached && failure?.code !== "audioStorageError"
            ? limitNotice
            : failure;
        j.setState("idle", audioError ?? stopNotice, elapsed);
        this.transient(id, { kind: "levels", levels: [0, 0] });
        this.transient(id, {
          kind: "audio",
          value: audioManifest(record.audio),
        });
        void j.export().catch((e) =>
          j.emit({
            kind: "notice",
            notice: { code: "storageError", detail: String(e) },
          }),
        );
      },
    });
    if (!speech) return;
    this.warm = { id, language, speech };
    speech.prepare(meeting.settings, j.directory, j.time());
  }
  start(id: string) {
    if (this.current) throw new Error("A meeting is already recording");
    const { project, meeting } = this.projects.find(id),
      j = this.journal(id);
    if (remainingTime(project, j) <= 0)
      throw new Error("This recording has reached the project duration limit");
    this.prepare(id);
    if (!this.warm)
      throw new Error(
        "Speech components are missing. Run npm run setup:speech.",
      );
    const { speech } = this.warm;
    this.warm = undefined;
    this.current = { id, project, journal: j, speech, limitReached: false };
    this.activity(id);
    j.setState("preparing");
    try {
      speech.startCapture(meeting.settings);
    } catch (e) {
      speech.force();
      throw e;
    }
  }
  private scheduleLimit(checkpoint = false) {
    const current = this.current;
    if (!current) return;
    clearTimeout(current.timer);
    const { id, project, journal } = current;
    const remaining = remainingTime(project, journal);
    if (remaining <= 0) {
      this.stop(id);
      return;
    }
    if (journal.state !== "recording") return;
    // Save elapsed time even in silence so crash recovery can resume the budget.
    if (checkpoint) journal.setState("recording", journal.notice);
    current.timer = setTimeout(
      () => this.scheduleLimit(true),
      Math.min(remaining, 30_000),
    );
    current.timer.unref();
  }
  limitChanged(project: Project) {
    if (this.current?.project === project) this.scheduleLimit();
    for (const { id } of project.meetings) {
      const journal = this.records.get(id)?.journal;
      if (
        journal &&
        this.current?.id !== id &&
        remainingTime(project, journal) <= 0
      ) {
        this.drafts?.cancel(id);
        this.editor.suspend(id, journal);
      }
    }
  }
  enqueueEditing(id: string, retry = false) {
    const { project, meeting } = this.projects.find(id);
    const journal = this.journal(id);
    if (
      remainingTime(project, journal) > 0 &&
      !(this.current?.id === id && this.current.limitReached)
    )
      this.editor.enqueue(meeting, journal, retry);
  }
  translationChanged(id: string) {
    this.drafts?.cancel(id);
    const { project, meeting } = this.projects.find(id);
    if (
      (this.current && (this.current.id !== id || this.current.limitReached)) ||
      remainingTime(project, this.journal(id)) <= 0
    )
      return;
    this.drafts?.prepare(meeting, true);
    if (this.current?.id === id) {
      const journal = this.current.journal;
      const latest = [...journal.rows.values()]
        .filter((r) => r.stage !== "interrupted")
        .slice(-3);
      for (const row of latest) this.drafts?.offer(meeting, journal, row);
    }
  }
  retryTranslation(id: string) {
    const { project, meeting } = this.projects.find(id);
    if (remainingTime(project, this.journal(id)) > 0)
      this.drafts?.prepare(meeting, true);
  }
  stop(id: string) {
    const current = this.current;
    if (!current || current.id !== id) return;
    clearTimeout(current.timer);
    const { project, journal } = current;
    const expired =
      !current.limitReached && remainingTime(project, journal) <= 0;
    if (expired) {
      current.limitReached = true;
      this.drafts?.cancel(id);
      this.editor.suspend(id, journal);
    }
    if (journal.state === "stopping" && !expired) return;
    this.drafts?.finishPartial(id);
    journal.setState("stopping", current.limitReached ? limitNotice : null);
    current.speech.stop();
  }
  async close() {
    this.drafts?.close();
    this.warm?.speech.force();
    if (this.current) {
      const id = this.current.id,
        j = this.journal(id);
      await new Promise<void>((resolve) => {
        const done = () => {
          if (j.state === "idle") {
            j.listeners.delete(done);
            resolve();
          }
        };
        j.listeners.add(done);
        this.stop(id);
      });
    }
    await Promise.all(
      [...this.records.values()].map(({ journal }) => journal.flush()),
    );
  }
}
