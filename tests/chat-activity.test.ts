import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AgentActivity } from "../modules/agent-runtime/activity.ts";
import { PiActivity } from "../modules/agent-runtime/pi/activity.ts";
import { readSavedActivity } from "../modules/agent-runtime/pi/saved-activity.ts";
import { emptyUsage } from "../modules/agent-runtime/types.ts";
import { ChatService } from "../modules/chat/service.ts";
import { ChatHistory } from "../modules/chat/history.ts";
import type { ChatEvent, ChatTurn } from "../modules/chat/types.ts";

const thinkingBlock = {
  type: "thinking",
  thinking: "private reasoning",
  thinkingSignature: JSON.stringify({
    type: "reasoning",
    encrypted_content: "private cipher",
    content: [{ type: "reasoning_text", text: "private content" }],
    summary: [{ type: "summary_text", text: "Checking the two dates." }],
  }),
};
const text = (value: string) => ({ type: "text", text: value });

test("thinking timing is live and only explicitly public summary text reaches the activity log", () => {
  const steps: AgentActivity[] = [];
  const pi = new PiActivity((step) => steps.push(step));
  for (const [i, type] of [
    "thinking_start",
    "thinking_delta",
    "thinking_end",
  ].entries())
    pi.event(
      {
        type: "message_update",
        assistantMessageEvent: {
          type,
          delta: "private delta",
          content: "private end",
          contentIndex: 0,
        },
      },
      100 + i * 10,
    );
  pi.event({
    type: "message_end",
    message: {
      role: "assistant",
      api: "openai-codex-responses",
      content: [thinkingBlock],
    },
  });
  assert.deepEqual(
    steps.map((step) => step.status),
    ["running", "done", "done"],
  );
  const summary = steps.at(-1)!;
  assert.ok(
    summary.kind === "thinking" &&
      summary.summary === "Checking the two dates.",
  );
  assert.equal(summary.durationMs, 20);
  for (const [api, block] of [
    ["openai-responses", { ...thinkingBlock, redacted: true }],
    [
      "openai-responses",
      { ...thinkingBlock, thinkingSignature: "opaque private value" },
    ],
    ["another-api", thinkingBlock],
  ] as const) {
    pi.assistant({ role: "assistant", api, content: [block] });
    const step = steps.at(-1)!;
    assert.ok(step.kind === "thinking" && step.summary === undefined);
  }
  assert.doesNotMatch(JSON.stringify(steps), /private/);
});

test("native tool calls retain their parameters, bounded output, nested calls and independent outcomes", () => {
  const updates = new Map<string, AgentActivity>();
  const pi = new PiActivity((step) => updates.set(step.id, step));
  const shell = {
    toolCallId: "one",
    toolName: "bash",
    args: { command: "pwd" },
  };
  const code = {
    toolCallId: "two",
    toolName: "codemode",
    args: { code: "text(await tools.read({path:'agenda.md'}))" },
  };
  pi.event({ type: "tool_execution_start", ...shell }, 10);
  pi.event({ type: "tool_execution_start", ...code }, 12);
  pi.event(
    {
      type: "tool_execution_update",
      ...shell,
      partialResult: { content: [text("working")] },
    },
    30,
  );
  const partial = updates.get("tool:one");
  assert.ok(
    partial?.kind === "tool" &&
      partial.output === "working" &&
      partial.status === "running",
  );
  pi.event(
    {
      type: "tool_execution_end",
      ...shell,
      isError: true,
      result: { content: [text("command failed")] },
    },
    42,
  );
  const result = {
    content: [
      text("a".repeat(90000)),
      { type: "image", data: "binary-payload" },
    ],
    details: {
      calls: [{ name: "read", args: "agenda.md", status: "ok", durationMs: 5 }],
    },
  };
  pi.event(
    { type: "tool_execution_end", ...code, result, durationMs: 210 },
    2000,
  );
  const [first, second] = updates.values();
  assert.ok(
    first.kind === "tool" &&
      first.status === "failed" &&
      first.target === "pwd" &&
      first.durationMs === 32,
  );
  assert.ok(
    second.kind === "tool" &&
      second.status === "done" &&
      second.calls?.[0].name === "read" &&
      second.durationMs === 210,
  );
  assert.equal(second.output?.length, 1600);
  assert.doesNotMatch(JSON.stringify(second), /binary-payload/);
});

test("a fast call remains visible after a single SSE batch, reconnect and journal reopen", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-activity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = new ChatService(
    () => dir,
    () => ({ rows: new Map(), names: {}, rawCursor: 0, rawChangedAt: () => 0 }),
    () => ({
      info: async () => ({ ready: true, models: [], reason: "ready" }),
      run: async (_prompt, _model, _thinking, _usage, stream) => {
        stream!.activity!({
          kind: "tool",
          id: "a",
          name: "read",
          status: "running",
        });
        stream!.activity!({
          kind: "tool",
          id: "a",
          name: "read",
          status: "done",
          output: "Agenda",
        });
        stream!.activity!({
          kind: "tool",
          id: "b",
          name: "bash",
          status: "running",
        });
        await gate;
        return { text: "Done", usage: { ...emptyUsage(), total: 7 } };
      },
    }),
    () => dir,
  );
  t.after(() => service.close());
  const room = await service.room("recording");
  const batched = new Promise<ChatEvent>((resolve) =>
    room.subscribe((e) => {
      if (e.kind === "delta") resolve(e);
    }),
  );
  const completed = new Promise<ChatTurn>((resolve) =>
    room.subscribe((e) => {
      if (e.kind === "turn" && e.turn.status === "complete") resolve(e.turn);
    }),
  );
  const id = randomUUID();
  await room.submit({
    id,
    question: "Check",
    model: "",
    thinking: "low",
    reference: null,
  });
  const batch = await batched;
  assert.ok(batch.kind === "delta");
  assert.deepEqual(
    batch.activity?.map((step) => step.status),
    ["done", "running"],
  );
  const snapshot = await new Promise<ChatEvent>((resolve) =>
    room.subscribe(resolve),
  );
  assert.ok(snapshot.kind === "snapshot");
  assert.deepEqual(snapshot.turns[0].activity, batch.activity);
  finish();
  const final = await completed;
  assert.deepEqual(
    final.activity?.map((step) => step.status),
    ["done", "interrupted"],
  );
  const history = await ChatHistory.open(dir);
  assert.deepEqual(history.get(id)?.activity, final.activity);
  assert.equal(history.totalTokens, 7);
});

test("older questions recover only matching native calls and summaries, without running Pi", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-activity-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const user = { role: "user", content: [text("Question")] };
  const think = {
    role: "assistant",
    api: "openai-responses",
    content: [
      thinkingBlock,
      {
        type: "toolCall",
        id: "1",
        name: "bash",
        arguments: { command: "pwd" },
      },
    ],
  };
  const result = {
    role: "toolResult",
    toolCallId: "1",
    toolName: "bash",
    content: [text("workspace")],
    isError: false,
  };
  const answer = { role: "assistant", content: [text("Answer")] };
  const messages = [
    user,
    think,
    result,
    answer,
    { ...user, content: [text("Another question")] },
    answer,
  ];
  const file = join(dir, "pi-session.jsonl");
  const log =
    messages
      .map((message) => JSON.stringify({ type: "message", message }))
      .join("\n") + "\n";
  const read = () =>
    readSavedActivity(dir, (prompt) => prompt === "Question", "Answer");
  assert.deepEqual(await read(), []);
  await writeFile(file, log);
  const steps = await read();
  assert.deepEqual(
    steps.map((step) => step.kind),
    ["thinking", "tool"],
  );
  assert.ok(
    steps[1].kind === "tool" &&
      steps[1].output === "workspace" &&
      steps[1].durationMs === undefined,
  );
  assert.doesNotMatch(JSON.stringify(steps), /private/);
  await writeFile(file, log + log);
  assert.deepEqual(await read(), []);
});
