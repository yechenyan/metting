import type { AgentHarness } from "../agent-runtime/types.ts";
import type { Meeting } from "../meetings/types.ts";
import type { Journal } from "../transcripts/journal.ts";
import { translationTarget } from "../transcripts/translation.ts";
import { readRevision } from "./context.ts";
import { applyRevision } from "./revision.ts";
import {
  nextBatch,
  requestBoundary,
  type EditingBatch,
  type EditingJob,
} from "./batches.ts";

type Task = {
  job: EditingJob;
  batch: EditingBatch;
  controller: AbortController;
  configuration: string;
  tokens: number;
};

function configuration({ settings }: Meeting) {
  return JSON.stringify([
    settings.editing,
    translationTarget(settings),
    settings.model,
    settings.thinking,
  ]);
}

export class Editor {
  private jobs = new Map<string, EditingJob>();
  private paused = new Set<string>();
  private workers: { harness: AgentHarness; task?: Task }[];
  private closed = false;

  constructor(
    harnesses: AgentHarness | readonly AgentHarness[],
    private live: (meeting: string, tokens: number) => void,
  ) {
    const pool: readonly AgentHarness[] = Array.isArray(harnesses)
      ? harnesses
      : [harnesses as AgentHarness];
    this.workers = pool.map((harness) => ({ harness }));
  }

  shutdown() {
    this.closed = true;
    for (const worker of this.workers) {
      worker.task?.controller.abort();
      worker.harness.close?.();
    }
    this.jobs.clear();
  }

  suspend(id: string, journal: Journal) {
    this.jobs.delete(id);
    this.paused.add(id);
    for (const { task } of this.workers)
      if (task?.job.meeting.id === id) task.controller.abort();
    this.live(id, 0);
    if (journal.aiStatus === "working" || journal.aiStatus === "queued")
      this.status(journal, "pending");
  }

  private job(meeting: Meeting, journal: Journal) {
    let job = this.jobs.get(meeting.id);
    if (!job) {
      job = { meeting, journal, history: new Set(), boundaries: [] };
      this.jobs.set(meeting.id, job);
    }
    return job;
  }

  organize(meeting: Meeting, journal: Journal) {
    if (!meeting.settings.editing || this.closed) return;
    const job = this.job(meeting, journal);
    for (const row of journal.rows.values())
      if (row.stage === "final") job.history.add(row.id);
    this.enqueue(meeting, journal, true);
  }

  enqueue(meeting: Meeting, journal: Journal, retry = false) {
    if (this.closed) return;
    if (retry) {
      this.paused.delete(meeting.id);
      for (const { task } of this.workers)
        if (
          task?.job.meeting.id === meeting.id &&
          task.configuration !== configuration(meeting)
        )
          task.controller.abort();
    }
    if (!meeting.settings.editing) {
      this.jobs.delete(meeting.id);
      this.status(journal, "idle");
      return;
    }
    if (this.paused.has(meeting.id)) return;
    this.job(meeting, journal);
    if (
      this.workers.every(
        ({ task }) => task && task.job.meeting.id !== meeting.id,
      )
    )
      this.status(journal, "queued");
    this.pump();
  }

  private status(journal: Journal, status: string) {
    if (journal.aiStatus !== status) journal.emit({ kind: "ai", status });
  }

  private tokens(id: string) {
    const total = this.workers.reduce(
      (n, { task }) =>
        n +
        (task?.job.meeting.id === id && !task.controller.signal.aborted
          ? task.tokens
          : 0),
      0,
    );
    this.live(id, total);
  }

  private pump() {
    if (this.closed) return;
    for (const worker of this.workers) {
      if (worker.task) continue;
      for (const [id, job] of this.jobs) {
        if (this.paused.has(id)) continue;
        const reserved = new Set<string>();
        for (const { task } of this.workers)
          if (task?.job.meeting.id === id)
            for (const key of task.batch.ids) reserved.add(key);
        const batch = nextBatch(job, reserved);
        if (!batch) {
          if (!reserved.size) {
            this.jobs.delete(id);
            this.status(job.journal, "idle");
            if (job.journal.state === "idle")
              void job.journal.export().catch((error) =>
                job.journal.emit({
                  kind: "notice",
                  notice: { code: "storageError", detail: String(error) },
                }),
              );
          }
          continue;
        }
        const task: Task = {
          job,
          batch,
          controller: new AbortController(),
          configuration: configuration(job.meeting),
          tokens: 0,
        };
        worker.task = task;
        this.jobs.delete(id);
        this.jobs.set(id, job);
        this.status(job.journal, "working");
        void this.run(worker.harness, task).finally(() => {
          worker.task = undefined;
          this.tokens(id);
          this.pump();
        });
        break;
      }
    }
  }

  private async run(harness: AgentHarness, task: Task) {
    const {
      job,
      batch,
      controller: { signal },
    } = task;
    const { meeting, journal } = job;
    const current = () =>
      !this.closed &&
      !signal.aborted &&
      task.configuration === configuration(meeting);
    try {
      const info = await harness.info();
      if (!current()) return;
      if (!info.ready) {
        this.pause(job, info.reason);
        return;
      }
      let sentAt = 0;
      const result = await harness.run(
        JSON.stringify(batch.context),
        meeting.settings.model,
        meeting.settings.thinking,
        (n) => {
          if (current() && n !== task.tokens && Date.now() - sentAt >= 250) {
            sentAt = Date.now();
            task.tokens = n;
            this.tokens(meeting.id);
          }
        },
        { signal },
      );
      journal.addUsage(result.usage);
      if (!current()) return;
      if (result.error) throw new Error(result.error);
      const reply = readRevision(result.text);
      const accepted = applyRevision(
        journal,
        batch.context,
        batch.target,
        reply,
        batch.needs,
      );
      if (accepted) {
        for (const id of accepted) job.history.delete(id);
        if (accepted.size === batch.ids.size)
          requestBoundary(job, batch, reply.revisit);
      }
    } catch (error) {
      if (!current()) return;
      this.pause(
        job,
        /limit|rate|quota|429/i.test(String(error)) ? "limited" : "failed",
      );
      journal.emit({
        kind: "notice",
        notice: {
          code: "aiError",
          detail: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private pause(job: EditingJob, status: string) {
    this.paused.add(job.meeting.id);
    this.status(job.journal, status);
  }
}
