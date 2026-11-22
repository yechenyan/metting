import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  emptyUsage,
  type AgentHarness,
  type AgentRun,
} from "../modules/agent-runtime/types.ts";
import { ChatService, ChatBusy } from "../modules/chat/service.ts";
import { ChatHistory } from "../modules/chat/history.ts";
import { ChatThreads, UnknownThread } from "../modules/chat/threads.ts";
import { chatPrompt } from "../modules/chat/context.ts";
import { prepareRecording } from "../modules/chat/recording-context.ts";
import { chatRequest } from "../modules/chat/routes.ts";
import {
  chatLimits,
  type ChatEvent,
  type ChatRequest,
  type ChatTurn,
} from "../modules/chat/types.ts";
import type { Segment } from "../modules/transcripts/types.ts";

const request = (): ChatRequest => ({
  id: randomUUID(),
  model: "test/model",
  thinking: "low",
  question: "Explain the decision.",
  reference: {
    ids: ["s15"],
    start: 15000,
    end: 15800,
    text: "the original wording",
    speaker: "Ada",
  },
});
const successful: AgentRun = {
  text: "A complete answer.",
  usage: { ...emptyUsage(), total: 17, requests: 1 },
};
const rows = new Map<string, Segment>(
  Array.from({ length: 50 }, (_, i) => {
    const id = "s" + i;
    return [
      id,
      {
        id,
        start: i * 1000,
        end: i * 1000 + 800,
        raw: "Speech " + i,
        speaker: "p1",
        stage: "final",
        revision: 1,
        language: "en",
      },
    ];
  }),
);
const source = {
  rows,
  names: { p1: "Ada" },
  rawCursor: 1,
  rawChangedAt: () => 1,
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("direct and quoted questions receive raw speech once, including during native session migration", () => {
  const req = request();
  const turns: ChatTurn[] = Array.from({ length: 60 }, (_, i) => ({
    ...request(),
    question: String(i),
    status: "complete",
    answer: "a".repeat(3000),
    tokens: 17,
  }));
  const prepared = prepareRecording(source, req.reference);
  const prompt = JSON.parse(chatPrompt(req, turns, prepared.evidence));
  assert.match(prompt.recording.quotation, /Ada: Speech 15$/);
  const lines = prompt.recording.transcript.split("\n");
  assert.equal(lines.length, 49);
  assert.match(lines[0], /Ada: Speech 0$/);
  assert.doesNotMatch(prompt.recording.transcript, /Speech 15\b/);
  assert.match(lines.at(-1), /Speech 49$/);
  assert.equal(prompt.previousConversation.at(-1).question, "59");
  assert.equal(prompt.previousConversation.at(-1).quote, undefined);
  assert.ok(prompt.previousConversation.length <= 8);
  assert.ok(JSON.stringify(prompt.previousConversation).length < 13000);
  const direct = { ...req, reference: null };
  const followup = JSON.parse(
    chatPrompt(direct, turns, prepareRecording(source, null).evidence),
  );
  assert.equal(followup.recording.transcript.split("\n").length, 50);
  assert.match(followup.recording.transcript, /Speech 15\b/);
  assert.equal(followup.recording.quotation, undefined);
  assert.throws(() => chatRequest({ ...req, question: " " }));
  assert.throws(() =>
    chatRequest({ ...req, reference: { ...req.reference, end: -1 } }),
  );
  assert.throws(() =>
    chatRequest({
      ...req,
      reference: { ...req.reference, text: "a".repeat(chatLimits.quote + 1) },
    }),
  );
});

test(
  "recording chats stream independently, recover mid-answer on reconnect, and charge a request once",
  { timeout: 7000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "desk-chat-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await Promise.all(["one", "two"].map((id) => mkdir(join(dir, id))));
    const runs: {
      prompt: string;
      result: ReturnType<typeof deferred<AgentRun>>;
    }[] = [];
    const factory = (): AgentHarness => ({
      info: async () => ({ ready: true, models: [], reason: "ready" }),
      run: async (prompt, _model, _thinking, _usage, stream) => {
        const result = deferred<AgentRun>();
        runs.push({ prompt, result });
        assert.ok(stream?.text);
        stream.text("A ");
        stream.text("partial reply.");
        stream!.signal.addEventListener(
          "abort",
          () =>
            result.resolve({ ...successful, text: "", usage: emptyUsage() }),
          { once: true },
        );
        return result.promise;
      },
    });
    const service = new ChatService(
      (id) => join(dir, id),
      () => source,
      factory,
      (id) => join(dir, id),
    );
    t.after(() => service.close());
    const [one, two] = await Promise.all([
      service.room("one"),
      service.room("two"),
    ]);
    const first = request(),
      second = request(),
      finished = deferred<void>(),
      stopped = deferred<void>();
    const streamed = deferred<void>(),
      batches: string[] = [];
    const detach = one.subscribe((event) => {
      if (event.kind === "delta") {
        batches.push(event.text);
        streamed.resolve();
      }
      if (event.kind === "turn" && event.turn.status === "complete")
        finished.resolve();
    });
    await Promise.all([one.submit(first), one.submit(first)]);
    await assert.rejects(one.submit(request()), ChatBusy);
    two.subscribe((event) => {
      if (event.kind === "turn" && event.turn.status === "stopped")
        stopped.resolve();
    });
    await two.submit(second);
    await streamed.promise;
    assert.equal(runs.length, 2);
    assert.deepEqual(batches, ["A partial reply."]);
    detach();
    const replay: ChatEvent[] = [];
    one.subscribe((event) => {
      replay.push(structuredClone(event));
      if (event.kind === "turn" && event.turn.status === "complete")
        finished.resolve();
    });
    assert.equal(
      replay[0].kind === "snapshot" && replay[0].turns[0].answer,
      "A partial reply.",
    );
    two.stop(first.id);
    assert.equal(two.history.turns[0].status, "answering");
    two.stop(second.id);
    await stopped.promise;
    runs[0].result.resolve(successful);
    await finished.promise;
    await one.submit(first);
    assert.equal(runs.length, 2);
    assert.equal(one.history.totalTokens, 17);
    assert.equal(two.history.totalTokens, 0);
    assert.equal(
      (await ChatHistory.open(join(dir, "one"))).turns[0].answer,
      successful.text,
    );
    assert.equal(
      (await ChatHistory.open(join(dir, "two"))).turns[0].status,
      "stopped",
    );
    const next = { ...request(), reference: null };
    await delay(0);
    await one.submit(next);
    for (let i = 0; i < 100 && runs.length < 3; i++) await delay(10);
    assert.equal(JSON.parse(runs[2].prompt).previousConversation, undefined);
    assert.equal(JSON.parse(runs[2].prompt).recording, undefined);
    assert.equal(JSON.parse(runs[1].prompt).previousConversation, undefined);
    one.stop(next.id);
  },
);

test("journal paginates and repairs a torn write and interrupted question on restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "desk-chat-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const history = await ChatHistory.open(dir);
  for (let i = 0; i < chatLimits.page + 2; i++) {
    await history.append({
      ...request(),
      answer: "Saved",
      status: "complete",
      tokens: 4,
    });
  }
  const final = {
    ...request(),
    answer: "",
    status: "answering" as const,
    tokens: 0,
  };
  await history.append(final);
  await appendFile(join(dir, "chat.jsonl"), '{"broken":');
  const reopened = await ChatHistory.open(dir);
  const page = reopened.page();
  assert.equal(page.turns.length, chatLimits.page);
  assert.equal(page.hasEarlier, true);
  assert.equal(reopened.page(page.turns[0].id).turns.length, 3);
  assert.equal(page.turns.at(-1)?.error, "interrupted");
  assert.equal(reopened.totalTokens, 4 * (chatLimits.page + 2));
  assert.equal(
    (await readFile(join(dir, "chat.jsonl"), "utf8")).includes("broken"),
    false,
  );
});

test("a recording can run independent conversations and resume each one by its stable directory", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "desk-chat-threads-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const recordings = ["first", "second"];
  for (const id of recordings) await mkdir(join(base, id));
  const pending = new Map<string, () => void>();
  const starts: { directory: string; seed: string; prompt: string }[] = [];
  const make = () =>
    new ChatService(
      (id) => join(base, id),
      () => source,
      () => ({
        info: async () => ({ ready: true, models: [], reason: "ready" }),
        run: async (prompt, _model, _thinking, _usage, options) => {
          const session = options!.conversation!;
          starts.push({
            directory: session.directory,
            prompt,
            seed: session.initialPrompt?.() ?? prompt,
          });
          await new Promise<void>((resolve) => {
            pending.set(session.directory, resolve);
            options!.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return successful;
        },
      }),
      () => base,
    );
  const service = make();
  t.after(() => service.close());
  const threads = service.threads("first");
  const id = randomUUID();
  assert.deepEqual(threads.list(), [{ id: "default", title: "" }]);
  assert.deepEqual(threads.create(id), threads.create(id));
  assert.throws(() => threads.create("../another"), /Invalid conversation ID/);
  assert.throws(() => service.room("second", id), UnknownThread);
  assert.throws(() => service.room("first", "../second"), UnknownThread);
  const main = await service.room("first");
  assert.equal(main, await service.room("first", "default"));
  const extra = await service.room("first", id);
  const first = { ...request(), question: "Default only", reference: null };
  const second = { ...request(), question: "Second topic", reference: null };
  async function waitFor(test: () => boolean) {
    for (let i = 0; i < 100 && !test(); i++) await delay(10);
    assert.ok(test());
  }
  await Promise.all([main.submit(first), extra.submit(second)]);
  await waitFor(() => pending.size === 2);
  assert.notEqual(starts[0].directory, starts[1].directory);
  main.stop(second.id);
  assert.equal(extra.history.turns[0].status, "answering");
  for (const finish of pending.values()) finish();
  await waitFor(
    () =>
      main.history.turns[0].status === "complete" &&
      extra.history.turns[0].status === "complete",
  );
  await service.close();
  const restored = make();
  t.after(() => restored.close());
  assert.deepEqual(new ChatThreads(join(base, "first")).list()[1], {
    id,
    title: "Second topic",
  });
  const reopened = await restored.room("first", id);
  assert.deepEqual(
    reopened.history.turns.map((v) => v.id),
    [second.id],
  );
  assert.equal(reopened.history.totalTokens, 17);
  const follow = { ...request(), question: "Continue", reference: null };
  await reopened.submit(follow);
  await waitFor(() => starts.length === 3);
  assert.equal(starts[2].directory, threads.directory(id));
  assert.equal(JSON.parse(starts[2].prompt).previousConversation, undefined);
  assert.equal(JSON.parse(starts[2].prompt).recording, undefined);
  assert.match(JSON.parse(starts[2].seed).recording.transcript, /Speech 49$/);
  assert.deepEqual(
    JSON.parse(starts[2].seed).previousConversation.map(
      (v: { question: string }) => v.question,
    ),
    ["Second topic"],
  );
  reopened.stop(follow.id);
  await waitFor(() => reopened.history.turns.at(-1)?.status === "stopped");
});
