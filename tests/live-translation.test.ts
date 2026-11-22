import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import {
  emptyUsage,
  type AgentHarness,
  type AgentRun,
} from "../modules/agent-runtime/types.ts";
import { nextBatch, type EditingJob } from "../modules/ai-editing/batches.ts";
import { makeContext } from "../modules/ai-editing/context.ts";
import { Editor } from "../modules/ai-editing/editor.ts";
import { DraftTranslations } from "../modules/local-translation/service.ts";
import { Projects } from "../modules/projects/repository.ts";
import { Journal } from "../modules/transcripts/journal.ts";
import {
  draftText,
  translationLanguages,
  translationTarget,
} from "../modules/transcripts/translation.ts";
import type { Segment } from "../modules/transcripts/types.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "meeting-live-translation-"));
  const repo = new Projects(dir);
  const meeting = repo.all[0].meetings[0];
  const journal = new Journal(join(dir, "journal"), () =>
    translationTarget(meeting.settings),
  );
  journal.setState("recording");
  t.after(async () => {
    await journal.flush();
    await rm(dir, { recursive: true, force: true });
  });
  return { meeting, journal, repo };
}
function row(n: number, stage: Segment["stage"] = "final"): Segment {
  return {
    id: String(n),
    raw: "Source " + n,
    start: n * 1000,
    end: n * 1000 + 800,
    speaker: "S1",
    stage,
    language: "de",
    revision: stage === "final" ? 1 : 0,
  };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < end, "Timed out waiting for the expected state");
    await delay(2);
  }
}

test("two Pi workers accept out-of-order revisions, batch backlog, and reconcile a boundary once", async (t) => {
  const { meeting, journal } = await fixture(t);
  type Context = NonNullable<ReturnType<typeof makeContext>>;
  const calls: { context: Context; finish: (options?: object) => void }[] = [];
  const harness: AgentHarness = {
    info: async () => ({ ready: true, models: [], reason: "ready" }),
    run: (message, _model, _thinking, preview) =>
      new Promise<AgentRun>((resolve) => {
        const context: Context = JSON.parse(message);
        preview(5);
        calls.push({
          context,
          finish: (options = {}) =>
            resolve({
              usage: { ...emptyUsage(), requests: 1, total: 10 },
              text: JSON.stringify({
                updates: context.editable.map((s) => ({
                  id: s.id,
                  revision: s.revision,
                  text: s.original + ".",
                  translation: "Translated " + s.id,
                })),
                ...options,
              }),
            }),
        });
      }),
  };
  const previews: number[] = [];
  const editor = new Editor([harness, { ...harness }], (_id, total) =>
    previews.push(total),
  );
  t.after(() => editor.shutdown());
  for (let i = 1; i <= 5; i++) {
    journal.emit({ kind: "segment", segment: row(i) });
    editor.enqueue(meeting, journal);
  }
  await until(() => calls.length === 2);
  assert.deepEqual(
    calls.map((c) => c.context.editable.map((s) => s.id)),
    [["1"], ["2"]],
  );
  assert.ok(previews.includes(10));
  calls[1].finish({ revisit: ["1", "2"] });
  await until(() => calls.length === 3);
  assert.equal(journal.rows.get("2")?.reviewed, true);
  assert.equal(journal.rows.get("1")?.reviewed, undefined);
  assert.deepEqual(
    calls[2].context.editable.map((s) => s.id),
    ["3", "4", "5"],
  );
  assert.deepEqual(
    calls[2].context.reference.map((s) => s.id),
    ["1", "2"],
  );
  calls[2].finish();
  await until(() => !!journal.rows.get("5")?.reviewed);
  assert.equal(calls.length, 3);
  calls[0].finish();
  await until(() => calls.length === 4);
  assert.equal(calls[3].context.reconciling, true);
  assert.deepEqual(
    calls[3].context.editable.map((s) => [s.id, s.revision]),
    [
      ["1", 2],
      ["2", 2],
    ],
  );
  calls[3].finish({
    turns: [
      {
        ids: ["1", "2"],
        text: "One continuous turn.",
        translation: "One translation.",
      },
    ],
    revisit: ["1", "2"],
  });
  await until(() => journal.aiStatus === "idle");
  assert.deepEqual(journal.reading.turn("1")?.ids, ["1", "2"]);
  assert.equal(journal.rows.get("1")?.raw, "Source 1");
  assert.equal(journal.usage.requests, 4);
  assert.equal(journal.usage.total, 40);
  assert.equal(calls.length, 4);
  assert.equal(previews.at(-1), 0);
});

test("a prior merged passage stays together on a new target", async (t) => {
  const { meeting, journal, repo } = await fixture(t);
  for (let n = 1; n <= 5; n++)
    journal.emit({
      kind: "segment",
      segment: {
        ...row(n),
        reviewed: true,
        translation: "Old",
        translationLanguage: "zh",
      },
    });
  journal.reading.replace({
    sourceIds: ["3", "4"],
    turns: [{ ids: ["3", "4"], text: "Merged" }],
  });
  repo.configure(meeting, { translationLanguage: "es" });
  const job: EditingJob = {
    meeting,
    journal,
    history: new Set(),
    boundaries: [],
  };
  const first = nextBatch(job, new Set())!;
  const second = nextBatch(job, first.ids)!;
  assert.deepEqual([...first.ids], ["1", "2"]);
  assert.deepEqual([...second.ids], ["3", "4", "5"]);
  assert.deepEqual(second.context.currentTurns?.[0].ids, ["3", "4"]);
});

test("local drafts follow ASR corrections and never overwrite Pi or advance chat context", async (t) => {
  const { repo, meeting, journal } = await fixture(t);
  const calls: {
    text: string;
    target: string;
    finish: (text: string) => void;
  }[] = [];
  const translate = new DraftTranslations(
    () => {},
    () => ({
      prepare: async () => {},
      close() {},
      translate: (_lang, target, text) =>
        new Promise((resolve) => calls.push({ text, target, finish: resolve })),
    }),
  );
  t.after(() => translate.close());
  const send = (r: Segment) => {
    journal.emit({ kind: "segment", segment: r });
    translate.offer(meeting, journal, r);
  };
  send({ ...row(1, "partial"), raw: "Hallo" });
  assert.equal(translate.status.state, "idle");
  send(row(1, "stream"));
  await until(() => calls.length === 1);
  const rawCursor = journal.rawCursor;
  calls[0].finish("First draft");
  await until(() => draftText(journal.rows.get("1")!, "zh") === "First draft");
  assert.equal(journal.rawCursor, rawCursor);
  await journal.export();
  assert.match(
    await readFile(journal.markdown, "utf8"),
    /Draft translation: First draft/,
  );
  const saved = (await readFile(journal.path, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line).change);
  assert.ok(
    saved.some(
      (event) => event.segment?.draftTranslation?.text === "First draft",
    ),
  );
  send({
    ...journal.rows.get("1")!,
    stage: "final",
    raw: "Corrected source",
    revision: 1,
  });
  await until(() => calls.length === 2);
  repo.configure(meeting, { translationLanguage: "fr" });
  translate.cancel(meeting.id);
  translate.offer(meeting, journal, journal.rows.get("1")!);
  calls[1].finish("Obsolete target");
  await until(() => calls.length === 3);
  assert.equal(calls[2].target, "fr");
  const transcript = {
    ...journal.rows.get("1")!,
    reviewed: true,
    revision: 2,
    translation: "Pi translation",
    translationLanguage: "fr",
  } as const;
  journal.emit({ kind: "revision", segments: [transcript] });
  calls[2].finish("Late local reply");
  await delay(5);
  assert.deepEqual(journal.rows.get("1"), transcript);
  assert.equal(journal.usage.requests, 0);
});

test("a failed model setup retains only the latest queued source per sentence for retry", async (t) => {
  const { repo, meeting, journal } = await fixture(t);
  let attempts = 0;
  const inputs: string[] = [];
  const translation = new DraftTranslations(
    () => {},
    () => ({
      prepare: async () => {
        if (++attempts === 1) throw new Error("Download interrupted");
      },
      close() {},
      translate: async (_src, _target, text) => {
        inputs.push(text);
        return "Draft";
      },
    }),
  );
  t.after(() => translation.close());
  const project = repo.create({
    defaults: { translationLanguage: "ja", editing: false, translate: true },
  });
  assert.equal(project.meetings[0].settings.translationLanguage, "ja");
  repo.configure(meeting, { editing: false });
  assert.equal(meeting.settings.translate, true);
  assert.equal(new Set(translationLanguages).size, 100);
  for (const seg of [row(1, "stream"), { ...row(1), raw: "Updated" }, row(2)]) {
    journal.emit({ kind: "segment", segment: seg });
    translation.offer(meeting, journal, seg);
  }
  await until(() => translation.status.state === "failed");
  translation.prepare(meeting, true);
  await until(() => !!journal.rows.get("2")?.draftTranslation);
  assert.deepEqual(inputs, ["Updated", "Source 2"]);
  assert.equal(attempts, 2);
});
