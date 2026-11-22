import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { emptyUsage } from "../modules/agent-runtime/types.ts";
import { chatPrompt } from "../modules/chat/context.ts";
import {
  prepareRecording,
  type RecordingEvidence,
} from "../modules/chat/recording-context.ts";
import { chatRequest } from "../modules/chat/routes.ts";
import { ChatService } from "../modules/chat/service.ts";
import { chatLimits, type ChatReference } from "../modules/chat/types.ts";
import { Journal } from "../modules/transcripts/journal.ts";
import {
  originalExcerpts,
  limitOriginal,
} from "../modules/transcripts/original-quotation.ts";
import type { Segment } from "../modules/transcripts/types.ts";

function row(i: number, raw = "Speech " + i): Segment {
  return {
    id: "s" + i,
    start: i * 3000,
    end: i * 3000 + 1500,
    raw,
    stage: "final",
    speaker: "p1",
    language: "en",
    revision: 1,
  };
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "desk-recording-context-"));
  const journal = new Journal(dir);
  t.after(async () => {
    await journal.flush();
    await rm(dir, { recursive: true, force: true });
  });
  return journal;
}
const request = {
  id: crypto.randomUUID(),
  question: "Explain the decision",
  model: "",
  thinking: "low",
  reference: null,
};
function wire(evidence: RecordingEvidence) {
  const payload = JSON.parse(chatPrompt(request, [], evidence));
  const encoded = JSON.stringify({ recording: payload.recording });
  assert.ok(
    encoded.length <= chatLimits.recording,
    "Encoded meeting context exceeded the shared limit",
  );
  return encoded;
}

test("three-hour recording reserves an old selection and fills the rest with the newest complete utterances", async (t) => {
  const j = await fixture(t);
  j.emit({ kind: "speaker", id: "p1", name: "Ada" });
  for (let i = 0; i < 3600; i++) {
    j.emit({
      kind: "segment",
      segment: row(i, `item-${i}| ` + 'Planning "A" \\ paths. '.repeat(5)),
    });
  }
  const ref: ChatReference = {
    ids: ["s5"],
    start: 15000,
    end: 16500,
    speaker: "Ada",
    text: "item-5|",
  };
  const first = prepareRecording(j, ref);
  const encoded = wire(first.evidence);
  assert.ok(encoded.length > 8600);
  assert.match(first.evidence.quotation!, /Ada: item-5\|$/);
  assert.doesNotMatch(first.evidence.transcript!, /item-(?:0|5|1799)\|/);
  const ids = Array.from(
    first.evidence.transcript!.matchAll(/item-(\d+)\|/g),
    (match) => Number(match[1]),
  );
  assert.deepEqual(
    ids,
    Array.from({ length: ids.length }, (_, i) => 3600 - ids.length + i),
  );
  const focus = prepareRecording(j, ref, first.cursor);
  assert.deepEqual(focus.evidence, { quotation: first.evidence.quotation });
  assert.deepEqual(prepareRecording(j, null, first.cursor).evidence, {});
  assert.deepEqual(await readdir(j.directory), ["transcript.jsonl"]);
});

test("raw corrections survive restart and AI revisions or translations never enter sidebar context", async (t) => {
  const j = await fixture(t);
  const one = row(0, "We chose Monday.");
  const two = row(1, "Partial words");
  j.emit({ kind: "segment", segment: one });
  j.emit({ kind: "segment", segment: { ...two, stage: "partial" } });
  const first = prepareRecording(j, null);
  assert.match(first.evidence.transcript!, /Partial words$/);
  await j.flush();
  j.emit({
    kind: "revision",
    segments: [
      {
        ...one,
        edited: "Editor-only rewrite",
        translation: "Nur eine Übersetzung",
        translationLanguage: "de",
      },
    ],
    plan: {
      sourceIds: ["s0", "s1"],
      turns: [
        {
          ids: ["s0", "s1"],
          text: "Editor merge",
          translation: "Plan translation",
        },
      ],
    },
  });
  assert.deepEqual(prepareRecording(j, null, first.cursor).evidence, {});
  j.emit({ kind: "segment", segment: { ...two, raw: "Confirmed Thursday." } });
  j.emit({ kind: "segment", segment: row(2, "New action item.") });
  const delta = prepareRecording(j, null, first.cursor);
  assert.equal(delta.evidence.transcript!.split("\n").length, 2);
  assert.match(delta.evidence.transcript!, /Confirmed Thursday/);
  assert.match(delta.evidence.transcript!, /New action item/);
  assert.doesNotMatch(
    wire(delta.evidence),
    /Monday|Partial words|Editor|bersetzung|translation/,
  );
  j.emit({ kind: "segment", segment: row(3, "Arrived during the answer.") });
  assert.doesNotMatch(wire(delta.initial()), /Arrived during/);
  await j.flush();
  const reopened = new Journal(j.directory);
  assert.match(
    prepareRecording(reopened, null, delta.cursor).evidence.transcript!,
    /^\[[^\n]+Arrived during the answer\.$/,
  );
  assert.match(
    prepareRecording(reopened, null, 90000).evidence.transcript!,
    /We chose Monday/,
  );
  const beforeRename = reopened.rawCursor;
  reopened.emit({ kind: "speaker", id: "p1", name: "Chris" });
  assert.match(
    prepareRecording(reopened, null, beforeRename).evidence.transcript!,
    /Chris: We chose Monday/,
  );
  await reopened.flush();
});

test("raw selections remain anchored through merged, translated, partial and replaced captions", async (t) => {
  const j = await fixture(t);
  const rows = [
    row(0, "We chose"),
    { ...row(1, "the cobalt door."), speaker: "S2" },
  ];
  for (const segment of rows) j.emit({ kind: "segment", segment });
  const original = originalExcerpts(rows, ["chose the cobalt"]);
  assert.deepEqual(original, [
    { id: "s0", text: "chose" },
    { id: "s1", text: "the cobalt" },
  ]);
  assert.deepEqual(originalExcerpts(rows, ["cobalt"]), [
    { id: "s1", text: "cobalt" },
  ]);
  const selected = {
    ids: ["s0", "s1"],
    start: 0,
    end: 4500,
    speaker: "Team",
    text: "Die kobaltblaue Tür.",
  };
  const withTranslation = prepareRecording(j, selected);
  assert.doesNotMatch(wire(withTranslation.evidence), /Die kobaltblaue/);
  assert.match(
    withTranslation.evidence.quotation!,
    /Speaker 1: We chose\n.*Speaker 2: the cobalt door\./,
  );
  assert.equal(withTranslation.evidence.transcript, undefined);
  const ref = { ...selected, original };
  assert.deepEqual(chatRequest({ ...request, reference: ref }).reference, ref);
  assert.throws(() =>
    chatRequest({
      ...request,
      reference: { ...ref, original: [{ id: "unrelated", text: "test" }] },
    }),
  );
  j.emit({ kind: "remove", id: "s0" });
  j.emit({
    kind: "segment",
    segment: { ...rows[0], id: "replacement", raw: "We selected" },
  });
  const saved = prepareRecording(j, ref);
  assert.match(saved.evidence.quotation!, /chose/);
  assert.doesNotMatch(wire(saved.evidence), /Die kobaltblaue/);
  assert.equal(saved.evidence.transcript, undefined);
  const clipped = limitOriginal(
    [{ id: "s", text: "x".repeat(3999) + "🙂" }],
    4000,
  );
  assert.equal(clipped[0].text, "x".repeat(3999));
});

test("oversized utterances and backlogged updates obey the same encoded budget as quotations", async (t) => {
  const j = await fixture(t);
  const base = row(0, "Anchor");
  j.emit({ kind: "segment", segment: base });
  const first = prepareRecording(j, null);
  const ref = {
    ids: ["s0"],
    start: 0,
    end: 1500,
    text: "Anchor",
    speaker: "Ada",
  };
  const raw = '🙂\n"\\'.repeat(16000) + " LAST";
  j.emit({ kind: "segment", segment: row(1, raw) });
  const delta = prepareRecording(j, ref, first.cursor);
  const encoded = wire(delta.evidence);
  assert.ok(encoded.length > 8980);
  assert.match(
    delta.evidence.transcript!,
    /^\[00:00:03–00:00:04.500\] Speaker 1: …/,
  );
  assert.ok(delta.evidence.transcript!.endsWith(" LAST"));
  assert.equal(
    delta.evidence.transcript!,
    Buffer.from(delta.evidence.transcript!).toString("utf8"),
  );
  assert.equal(encoded.match(/Anchor/g)?.length, 1);
  for (let i = 2; i < 80; i++)
    j.emit({
      kind: "segment",
      segment: row(i, "batch-" + i + " " + "x".repeat(450)),
    });
  const latest = prepareRecording(j, ref, first.cursor);
  assert.doesNotMatch(wire(latest.evidence), / LAST|batch-2 /);
  assert.match(latest.evidence.transcript!, /batch-79 /);
});

test(
  "a failed reply keeps its raw updates available to the next question",
  { timeout: 4000 },
  async (t) => {
    const j = await fixture(t);
    const sent: (RecordingEvidence | undefined)[] = [];
    const service = new ChatService(
      () => j.directory,
      () => j,
      () => ({
        info: async () => ({ ready: true, models: [], reason: "ready" }),
        run: async (prompt) => {
          sent.push(JSON.parse(prompt).recording);
          if (sent.length === 2) throw new Error("Request interrupted");
          return { text: "Done", usage: emptyUsage() };
        },
      }),
      () => j.directory,
    );
    const room = await service.room("recording");
    async function ask() {
      const id = crypto.randomUUID();
      const done = new Promise<string>((resolve) => {
        const off = room.subscribe((event) => {
          if (
            event.kind === "turn" &&
            event.turn.id === id &&
            event.turn.status !== "answering"
          ) {
            off();
            resolve(event.turn.status);
          }
        });
      });
      await room.submit({ ...request, id });
      const status = await done;
      await nextTick();
      return status;
    }
    try {
      j.emit({ kind: "segment", segment: row(0, "Earlier context.") });
      assert.equal(await ask(), "complete");
      j.emit({ kind: "segment", segment: row(1, "Undelivered update.") });
      assert.equal(await ask(), "failed");
      j.emit({ kind: "segment", segment: row(2, "Latest statement.") });
      assert.equal(await ask(), "complete");
      assert.match(sent[2]!.transcript!, /Undelivered update/);
      assert.match(sent[2]!.transcript!, /Latest statement/);
      assert.doesNotMatch(sent[2]!.transcript!, /Earlier context/);
      assert.equal(await ask(), "complete");
      assert.equal(sent[3], undefined);
    } finally {
      await service.close();
    }
  },
);
