import type { AgentHarness } from "../agent-runtime/types.ts";
import {
  finishActivity,
  mergeActivity,
  type AgentActivity,
} from "../agent-runtime/activity.ts";
import { resolve } from "node:path";
import type { TranscriptSource } from "../transcripts/context-snapshot.ts";
import { chatPrompt } from "./context.ts";
import { prepareRecording } from "./recording-context.ts";
import { ChatHistory } from "./history.ts";
import { ChatThreads } from "./threads.ts";
import { defaultThread } from "./types.ts";
import type { ChatError, ChatEvent, ChatRequest, ChatTurn } from "./types.ts";

type Listener = (event: ChatEvent) => void;
export class ChatBusy extends Error {}

function failure(message: string): ChatError {
  if (message === "login" || message === "models" || message === "runtime")
    return message;
  if (/rate.limit|usage.limit|quota|too many requests|\b429\b/i.test(message))
    return "limited";
  return "failed";
}

export class Conversation {
  private listeners = new Set<Listener>();
  private job?: {
    id: string;
    controller: AbortController;
    accepted: Promise<void>;
    done: Promise<void>;
  };
  private harness?: AgentHarness;
  private activityReads = new Map<string, Promise<AgentActivity[]>>();
  private expiry?: NodeJS.Timeout;
  private closed = false;
  constructor(
    readonly history: ChatHistory,
    private transcript: () => TranscriptSource | Promise<TranscriptSource>,
    private createHarness: () => AgentHarness,
    private expire: () => void,
    private projectFolder: () => string,
    private directory: string,
    private name: (title: string) => void,
  ) {
    this.scheduleExpiry();
  }

  private scheduleExpiry() {
    clearTimeout(this.expiry);
    if (this.job || this.listeners.size || this.closed) return;
    this.expiry = setTimeout(() => {
      this.harness?.close?.();
      this.expire();
    }, 60000);
    this.expiry.unref();
  }
  subscribe(listener: Listener) {
    this.listeners.add(listener);
    clearTimeout(this.expiry);
    listener({
      kind: "snapshot",
      ...this.history.page(),
      totalTokens: this.history.totalTokens,
    });
    return () => {
      this.listeners.delete(listener);
      this.scheduleExpiry();
    };
  }
  private emit(event: ChatEvent) {
    for (const listener of this.listeners) listener(event);
  }
  private publish(turn: ChatTurn) {
    this.emit({ kind: "turn", turn, totalTokens: this.history.totalTokens });
  }
  async readActivity(id: string) {
    const turn = this.history.get(id);
    if (!turn) throw new Error("Unknown question");
    if (turn.activity || turn.status === "answering")
      return turn.activity ?? [];
    const pending = this.activityReads.get(id);
    if (pending) return pending;
    this.harness ??= this.createHarness();
    const read =
      this.harness.readActivity?.(
        this.directory,
        (text) => {
          try {
            const prompt = JSON.parse(text);
            if (prompt.questionId) return prompt.questionId === turn.id;
            const quote = turn.reference;
            return (
              prompt.question === turn.question &&
              (quote
                ? prompt.quotation?.text === quote.text &&
                  prompt.quotation.startSeconds === quote.start / 1000 &&
                  prompt.quotation.endSeconds === quote.end / 1000 &&
                  prompt.quotation.speaker === quote.speaker
                : prompt.quotation === null)
            );
          } catch {
            return false;
          }
        },
        turn.answer,
      ) ?? Promise.resolve([]);
    const result = read
      .then((steps) => (turn.activity = steps))
      .finally(() => this.activityReads.delete(id));
    this.activityReads.set(id, result);
    return result;
  }
  async submit(request: ChatRequest) {
    if (this.closed) throw new Error("Conversation is closing");
    if (this.job?.id === request.id) return this.job.accepted;
    if (this.history.has(request.id)) return;
    if (this.job) throw new ChatBusy("A reply is already in progress");
    const folder = this.projectFolder();
    if (!this.history.turns.length)
      this.name(request.reference?.text ?? request.question);
    const turn: ChatTurn = {
      ...request,
      status: "answering",
      answer: "",
      tokens: 0,
      activity: [],
    };
    const controller = new AbortController();
    clearTimeout(this.expiry);
    const accepted = this.history.append(turn).then(() => this.publish(turn));
    const done = accepted
      .then(() => this.answer(turn, controller.signal, folder))
      .finally(() => {
        this.job = undefined;
        this.scheduleExpiry();
      });
    this.job = { id: turn.id, accepted, done, controller };
    // The HTTP caller observes acceptance, while generation outlives its connection.
    void done.catch(() => {});
    return accepted;
  }
  private async answer(turn: ChatTurn, signal: AbortSignal, folder: string) {
    let buffer = "";
    let reported = 0;
    const pending = new Map<string, AgentActivity>();
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!buffer && reported === (turn.liveTokens ?? 0) && !pending.size)
        return;
      const text = buffer;
      buffer = "";
      turn.answer += text;
      turn.liveTokens = reported;
      const activity = pending.size ? Array.from(pending.values()) : undefined;
      if (activity) {
        turn.activity = mergeActivity(turn.activity, activity);
        pending.clear();
      }
      this.emit({
        kind: "delta",
        id: turn.id,
        text,
        liveTokens: reported,
        activity,
      });
    };
    const finished: ChatTurn = { ...turn };
    try {
      signal.throwIfAborted();
      const source = await this.transcript();
      signal.throwIfAborted();
      const delivered = this.history.turns.findLast(
        (item) => item.status === "complete",
      );
      const context = prepareRecording(
        source,
        turn.reference,
        delivered?.recordingCursor,
      );
      // Persist the captured partial before its final recognition can coalesce it.
      if (context.cursor !== delivered?.recordingCursor) await source.flush?.();
      signal.throwIfAborted();
      const prompt = chatPrompt(turn, [], context.evidence, folder);
      this.harness ??= this.createHarness();
      const reply = await this.harness.run(
        prompt,
        turn.model,
        turn.thinking,
        (tokens) => {
          if (tokens > reported && !signal.aborted) {
            reported = tokens;
            timer ??= setTimeout(flush, 48);
          }
        },
        {
          signal,
          conversation: {
            directory: this.directory,
            workingDirectory: folder,
            initialPrompt:
              this.history.turns.length > 1
                ? () =>
                    chatPrompt(
                      turn,
                      this.history.turns,
                      context.initial(),
                      folder,
                      resolve(this.directory, "chat.jsonl"),
                    )
                : undefined,
          },
          activity: (step) => {
            if (signal.aborted) return;
            pending.set(step.id, step);
            timer ??= setTimeout(flush, 48);
          },
          text: (part) => {
            if (signal.aborted || !part) return;
            buffer += part;
            timer ??= setTimeout(flush, 48);
          },
        },
      );
      flush();
      finished.tokens = reply.usage.total;
      finished.answer = reply.text || turn.answer;
      if (reply.error || !finished.answer.trim())
        throw new Error(reply.error || "The model returned an empty reply");
      finished.status = "complete";
      finished.recordingCursor = context.cursor;
    } catch (error) {
      flush();
      finished.detail =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "Agent request failed";
      finished.error = failure(finished.detail);
      finished.status = "failed";
      finished.answer ||= turn.answer;
    }
    if (signal.aborted) {
      finished.status = "stopped";
      delete finished.error;
      delete finished.detail;
    }
    finished.activity = finishActivity(turn.activity ?? []);
    try {
      await this.history.append(finished);
    } catch {
      // Keep the answer accessible in this process even if the local disk is full.
      const retained: ChatTurn = {
        ...finished,
        status: "failed",
        error: "storage",
      };
      this.history.retainAfterFailure(retained);
      this.publish(retained);
      return;
    }
    this.publish(finished);
  }
  stop(id: string) {
    if (this.job?.id === id) this.job.controller.abort();
  }
  async close() {
    this.closed = true;
    clearTimeout(this.expiry);
    this.job?.controller.abort();
    await this.job?.done.catch(() => {});
    this.harness?.close?.();
  }
}

export class ChatService {
  private rooms = new Map<string, Promise<Conversation>>();
  private closed = false;
  constructor(
    private directory: (id: string) => string,
    private transcript: (
      id: string,
    ) => TranscriptSource | Promise<TranscriptSource>,
    private createHarness: () => AgentHarness,
    private projectFolder: (id: string) => string,
  ) {}
  threads(id: string) {
    return new ChatThreads(this.directory(id));
  }
  room(id: string, threadId = defaultThread) {
    if (this.closed) throw new Error("Chat service is closing");
    const key = JSON.stringify([id, threadId]);
    let room = this.rooms.get(key);
    if (!room) {
      const threads = this.threads(id);
      const directory = threads.directory(threadId);
      room = ChatHistory.open(directory)
        .then(
          (history) =>
            new Conversation(
              history,
              () => this.transcript(id),
              this.createHarness,
              () => this.rooms.delete(key),
              () => this.projectFolder(id),
              directory,
              (title) => threads.name(threadId, title),
            ),
        )
        .catch((error) => {
          this.rooms.delete(key);
          throw error;
        });
      this.rooms.set(key, room);
    }
    return room;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(
      [...this.rooms.values()].map(async (room) => (await room).close()),
    );
    this.rooms.clear();
  }
}
