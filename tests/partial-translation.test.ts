import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Editor } from "../modules/ai-editing/editor.ts";
import { DraftTranslations } from "../modules/local-translation/service.ts";
import { countSourceWords } from "../modules/local-translation/partials.ts";
import { draftScope, keepsPrefix } from "../modules/transcripts/drafts.ts";
import { Meetings } from "../modules/meetings/service.ts";
import { Projects } from "../modules/projects/repository.ts";
import type { SpeechCallbacks } from "../modules/speech/local.ts";
import type { Segment } from "../modules/transcripts/types.ts";
import { Journal } from "../modules/transcripts/journal.ts";
import {
  draftText,
  translatedText,
} from "../modules/transcripts/translation.ts";

function segment(
  raw: string,
  end: number,
  stage: Segment["stage"] = "partial",
): Segment {
  return {
    id: "sentence",
    language: "en",
    speaker: "unknown",
    start: 0,
    end,
    raw,
    stage,
    revision: 0,
  };
}

async function until(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < end, "Timed out waiting for translation");
    await delay(3);
  }
}

async function recording(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "meeting-live-previews-"));
  const projects = new Projects(dir);
  const meeting = projects.all[0].meetings[0];
  projects.configure(meeting, {
    language: "en",
    editing: false,
    translate: true,
  });
  const calls: { raw: string; finish: (text: string) => void }[] = [];
  const drafts = new DraftTranslations(
    () => {},
    () => ({
      prepare: async () => {},
      close() {},
      translate: (_source, _target, raw) =>
        new Promise((resolve) => calls.push({ raw, finish: resolve })),
    }),
  );
  const editor = new Editor(
    {
      info: async () => {
        throw new Error("Unexpected Pi request");
      },
      run: async () => {
        throw new Error("Unexpected Pi request");
      },
    },
    () => {},
  );
  let capture!: SpeechCallbacks;
  const service = new Meetings(
    projects,
    editor,
    () => {},
    () => {},
    (_language, callbacks) => {
      capture = callbacks;
      return {
        prepare() {},
        startCapture: () => capture.ready(),
        stop: () => capture.end(null),
        force() {},
      };
    },
    drafts,
  );
  const journal = service.journal(meeting.id);
  t.after(async () => {
    await service.close();
    editor.shutdown();
    await journal.export();
    await rm(dir, { force: true, recursive: true });
  });
  service.start(meeting.id);
  let elapsed = 0;
  return {
    calls,
    journal,
    projects,
    meeting,
    service,
    send(raw: string, stage: Segment["stage"] = "partial", id = "sentence") {
      capture.segment({ ...segment(raw, (elapsed += 100), stage), id });
    },
  };
}

test("live translation coalesces five-word advances and retains the previous draft during source corrections", async (t) => {
  const { calls, journal, send } = await recording(t);
  const first = "we can test the system";
  const ten = first + " tomorrow morning before the meeting";
  const latest = ten + " starts";
  const corrected = latest.replace("we can", "we cannot");
  send("we");
  send(first);
  await until(() => calls.length === 1);
  assert.equal(calls[0].raw, first);
  send(first + " tomorrow morning");
  send(ten);
  send(latest);
  const cursor = journal.rawCursor;
  calls[0].finish("Positive draft");
  await until(() => calls.length === 2);
  assert.equal(calls[1].raw, latest);
  assert.equal(journal.rows.get("sentence")?.raw, latest);
  assert.equal(journal.rows.get("sentence")?.stage, "partial");
  assert.equal(journal.rawCursor, cursor);
  assert.equal(journal.rows.get("sentence")?.draftTranslation?.source, first);
  send(corrected);
  assert.equal(
    journal.rows.get("sentence")?.draftTranslation?.text,
    "Positive draft",
  );
  assert.equal(draftScope(journal.rows.get("sentence")!), "previous");
  send(corrected + ".", "stream");
  assert.equal(
    journal.rows.get("sentence")?.draftTranslation?.text,
    "Positive draft",
  );
  const published: string[] = [];
  journal.listeners.add(({ change }) => {
    if (change.kind === "segment" && change.segment.draftTranslation)
      published.push(change.segment.draftTranslation.text);
  });
  calls[1].finish("Obsolete positive draft");
  await until(() => calls.length === 3);
  assert.equal(calls[2].raw, corrected + ".");
  calls[2].finish("Negative draft");
  await until(() => published.length > 0);
  assert.deepEqual(published, ["Negative draft"]);
  assert.equal(draftScope(journal.rows.get("sentence")!), "current");
  assert.equal(journal.rows.size, 1);
  assert.equal(journal.usage.requests, 0);
});

test("only five new words trigger another preview, and a short endpoint is translated", async (t) => {
  const { calls, journal, send } = await recording(t);
  const words =
    "we will test the system early next week before the meeting".split(" ");
  const phrase = (n: number) => words.slice(0, n).join(" ");
  for (let n = 1; n < 5; n++) send(phrase(n));
  await delay(5);
  assert.equal(calls.length, 0);
  send(phrase(5));
  await until(() => calls.length === 1);
  calls[0].finish("First draft");
  await until(() => !!journal.rows.get("sentence")?.draftTranslation);
  for (let n = 6; n <= 9; n++) send(phrase(n));
  send(phrase(9).replace("will", "can"));
  send(phrase(4));
  send(phrase(9));
  await delay(1100);
  assert.equal(calls.length, 1);
  send(phrase(10));
  await until(() => calls.length === 2);
  assert.equal(calls[1].raw, phrase(10));
  calls[1].finish("Next draft");
  send(phrase(11), "stream");
  await until(() => calls.length === 3);
  assert.equal(calls[2].raw, phrase(11));
  calls[2].finish("Whole sentence");
  send("thanks", "partial", "reply");
  await delay(5);
  assert.equal(calls.length, 3);
  send("thanks", "stream", "reply");
  await until(() => calls.length === 4);
  assert.equal(calls[3].raw, "thanks");
  calls[3].finish("Short reply");
  await until(() => !!journal.rows.get("reply")?.draftTranslation);
});

test("the endpoint reuses a live inference with identical text and bypasses the preview cadence for changed wording", async (t) => {
  const { calls, send, journal } = await recording(t);
  send("this is a short phrase");
  await until(() => calls.length === 1);
  send("this is a short phrase", "stream");
  calls[0].finish("Complete draft");
  await until(() => !!journal.rows.get("sentence")?.draftTranslation);
  assert.equal(journal.rows.get("sentence")?.stage, "stream");
  assert.equal(
    journal.rows.get("sentence")?.draftTranslation?.text,
    "Complete draft",
  );
  send("this is a short phrase.", "final");
  await until(() => calls.length === 2);
  assert.equal(calls[1].raw, "this is a short phrase.");
  calls[1].finish("Corrected draft");
  await until(
    () =>
      journal.rows.get("sentence")?.draftTranslation?.source ===
      "this is a short phrase.",
  );
});

test("changing target or disabling local translation discards outdated previews", async (t) => {
  const { calls, send, projects, journal, meeting, service } =
    await recording(t);
  send("we start testing this system");
  await until(() => calls.length === 1);
  send("we start testing this system again");
  projects.configure(meeting, { translationLanguage: "fr" });
  service.translationChanged(meeting.id);
  calls[0].finish("Old target");
  await until(() => calls.length === 2);
  assert.equal(journal.rows.get("sentence")?.draftTranslation, undefined);
  assert.equal(calls[1].raw, "we start testing this system again");
  calls[1].finish("French draft");
  await until(
    () => journal.rows.get("sentence")?.draftTranslation?.language === "fr",
  );
  send("we start testing this system again tomorrow");
  projects.configure(meeting, { localTranslation: false });
  service.translationChanged(meeting.id);
  send("we start testing this system again tomorrow with the updated software");
  await delay(5);
  assert.equal(calls.length, 2);
});

test("live speech can pass a backlog and settled sentences still get a turn", async (t) => {
  const { calls, send, journal } = await recording(t);
  send("Completed first.", "final", "one");
  await until(() => calls.length === 1);
  send("Completed second.", "final", "two");
  send("Completed third.", "final", "three");
  send("a new speaker begins now");
  calls[0].finish("First result");
  await until(() => calls.length === 2);
  assert.equal(calls[1].raw, "a new speaker begins now");
  send("a new speaker begins now continues");
  calls[1].finish("Live result");
  await until(() => calls.length === 3);
  assert.equal(calls[2].raw, "Completed second.");
  send("a new speaker begins now continues.", "stream");
  calls[2].finish("Second result");
  await until(() => calls.length === 4);
  assert.equal(calls[3].raw, "Completed third.");
  calls[3].finish("Third result");
  await until(() => calls.length === 5);
  assert.equal(calls[4].raw, "a new speaker begins now continues.");
  calls[4].finish("Full result");
  await until(
    () =>
      journal.rows.get("sentence")?.draftTranslation?.text === "Full result",
  );
});

test("counts words in German, English and unspaced Mandarin", () => {
  assert.equal(
    countSourceWords("Heute testen wir das E-Mail-System.", "de"),
    5,
  );
  assert.equal(countSourceWords("We can't ship it today!", "en"), 5);
  assert.equal(countSourceWords("... ?!", "en"), 0);
  const fourWords = String.fromCodePoint(
    0x6211,
    0x4eec,
    0x4eca,
    0x5929,
    0x4e0b,
    0x5348,
    0x8ba8,
    0x8bba,
  );
  assert.equal(countSourceWords(fourWords, "zh"), 4);
  assert.equal(
    countSourceWords(
      fourWords + String.fromCodePoint(0x9879, 0x76ee) + "!",
      "zh",
    ),
    5,
  );
  assert.equal(keepsPrefix("we cannot", "we can", "en"), false);
  assert.equal(keepsPrefix("we can go", "we can", "en"), true);
});

test("replay and Pi handoff preserve the last good local translation on its own utterance", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-retained-translation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = "we can agree before the break";
  const draft = { language: "zh" as const, source, text: "First translation" };
  const first = { ...segment(source, 1400), draftTranslation: draft };
  const endpoint = segment(source + " please continue", 2300, "stream");
  const final = {
    ...segment("We will agree.", 1100, "final"),
    start: 50,
    speaker: "S1",
    streamId: first.id,
  };
  const sibling = {
    ...segment("Please continue.", 2300, "final"),
    id: "sentence-1",
    start: 1100,
    speaker: "S2",
    streamId: first.id,
  };
  const oldEvents = [first, endpoint, final, sibling].map((row, i) =>
    JSON.stringify({ seq: i + 1, change: { kind: "segment", segment: row } }),
  );
  await writeFile(join(dir, "transcript.jsonl"), oldEvents.join("\n") + "\n");
  const journal = new Journal(dir, () => "zh");
  const row = journal.rows.get(first.id)!;
  assert.deepEqual(row.draftTranslation, draft);
  assert.equal(draftScope(row), "shared");
  assert.equal(draftText(row, "fr"), undefined);
  assert.equal(journal.rows.get(sibling.id)?.draftTranslation, undefined);
  await journal.export();
  assert.match(
    await readFile(journal.markdown, "utf8"),
    /Draft translation before speaker split: First translation/,
  );
  const before = journal.seq;
  journal.emit({
    kind: "revision",
    segments: [
      {
        ...final,
        revision: 2,
        edited: "We will agree.",
        translationLanguage: "zh",
        translation: "Pi translation",
      },
    ],
  });
  const delivered = journal.since(journal.epoch, before)?.[0].change;
  assert.ok(delivered?.kind === "revision");
  assert.deepEqual(delivered.segments[0].draftTranslation, draft);
  assert.equal(translatedText(delivered.segments[0], "zh"), "Pi translation");
  await journal.export();
  assert.match(await readFile(journal.markdown, "utf8"), /Pi translation/);
  assert.deepEqual(
    new Journal(dir).rows.get(first.id)?.draftTranslation,
    draft,
  );
});
