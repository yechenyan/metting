import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Projects } from "../modules/projects/repository.ts";
import { Journal } from "../modules/transcripts/journal.ts";
import {
  captionStatus,
  ReadingLayout,
  turnTranslation,
} from "../modules/transcripts/reading.ts";
import { translatedText } from "../modules/transcripts/translation.ts";
import { streamingResult } from "../modules/transcripts/recognition.ts";
import type { Segment } from "../modules/transcripts/types.ts";
import { validateArrangement } from "../modules/ai-editing/arrangement.ts";
import { Editor } from "../modules/ai-editing/editor.ts";
import { makeContext } from "../modules/ai-editing/context.ts";
import { applyRevision } from "../modules/ai-editing/revision.ts";
import { emptyUsage } from "../modules/agent-runtime/types.ts";

const source = (id: string, start = 1000, speaker = "S1"): Segment => ({
  id,
  start,
  end: start + 750,
  speaker,
  language: "en",
  stage: "final",
  raw: "Original " + id,
  revision: 1,
});
const rows = [source("a"), source("b", 2000, "S2"), source("c", 3000)];
const turns = [
  { ids: ["b"] },
  { ids: ["a", "c"], text: "Joined turn.", translation: "Translated turn." },
];

test("new sessions inherit translation and migrated sessions keep their saved switch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-defaults-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const p = new Projects(dir).all[0];
  assert.equal(p.meetings[0].settings.translate, true);
  p.defaults.translate = false;
  p.meetings[0].settings.translate = false;
  await writeFile(join(dir, "projects.json"), JSON.stringify([p]));
  const reopened = new Projects(dir);
  assert.equal(reopened.project(p.id).meetings[0].settings.translate, false);
  assert.equal(reopened.add(p.id).settings.translate, true);
  const custom = reopened.create({ defaults: { translate: false } });
  assert.equal(new Projects(dir).add(custom.id).settings.translate, false);
  assert.equal(
    reopened.create({ defaults: { editing: false } }).meetings[0].settings
      .translate,
    false,
  );
});

test("caption status waits for sentence recognition and the requested AI translation", () => {
  const row = source("a");
  for (const stage of ["partial", "stream", "interrupted"] as const) {
    assert.equal(captionStatus({ ...row, stage }, "zh", undefined), stage);
  }
  assert.equal(
    captionStatus({ ...row, refinement: "fallback" }, "zh", undefined),
    "fallback",
  );
  const reviewed: Segment = {
    ...row,
    reviewed: true,
    translation: "English to French",
    translationLanguage: "fr",
    draftTranslation: { source: row.raw, language: "zh", text: "Local draft" },
  };
  assert.equal(
    captionStatus(reviewed, "zh", translatedText(reviewed, "zh")),
    "sentence",
  );
  assert.equal(
    captionStatus(reviewed, "fr", translatedText(reviewed, "fr")),
    "translated",
  );
  assert.equal(captionStatus(reviewed, null, undefined), "reviewed");
  assert.equal(captionStatus(reviewed, "en", undefined), "reviewed");
  const legacy = { ...row, edited: row.raw, translation: "Legacy translation" };
  assert.equal(
    captionStatus(legacy, "zh", translatedText(legacy, "zh")),
    "translated",
  );

  const turn = { ids: ["a", "b"], text: "Combined speech" };
  const sources = new Map([
    ["a", reviewed],
    ["b", source("b")],
  ]);
  assert.equal(
    captionStatus(reviewed, "fr", turnTranslation(turn, sources, "fr"), turn),
    "sentence",
  );
  const complete = {
    ...turn,
    translation: "Combined translation",
    translationLanguage: "fr" as const,
  };
  assert.equal(
    captionStatus(
      reviewed,
      "fr",
      turnTranslation(complete, sources, "fr"),
      complete,
    ),
    "translated",
  );
});

test("journal replays legacy stages and diarization splits without inventing a streaming result", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-levels-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parent = "a".repeat(32),
    s = source(parent);
  const events: Segment[] = [
    { ...s, stage: "partial", raw: "Initial hypothesis", end: 1400 },
    { ...s, stage: "stream", raw: "Two voices", end: 3200 },
    { ...s, raw: "First speaker" },
    { ...source(parent + "-1", 2000, "S2"), raw: "Second speaker" },
    {
      ...s,
      raw: "First speaker",
      edited: "First speaker.",
      reviewed: true,
      revision: 2,
    },
    source("missing"),
  ];
  await writeFile(
    join(dir, "transcript.jsonl"),
    events
      .map((segment, n) =>
        JSON.stringify({ seq: n + 1, change: { kind: "segment", segment } }),
      )
      .join("\n") + "\n",
  );
  const log = new Journal(dir);
  for (const id of [parent, parent + "-1"]) {
    assert.deepEqual(log.rows.get(id)?.streaming, {
      id: parent,
      start: 1000,
      end: 3200,
      text: "Two voices",
      lastPartial: "Initial hypothesis",
    });
  }
  assert.equal(log.rows.get(parent)?.edited, "First speaker.");
  assert.equal(streamingResult(log.rows.get("missing")!), undefined);
  log.emit({
    kind: "segment",
    segment: { ...source("d"), stage: "stream", raw: "Stream only" },
  });
  log.emit({
    kind: "segment",
    segment: { ...source("d"), refinement: "fallback", raw: "Stream only" },
  });
  await log.flush();
  const restored = new Journal(dir);
  assert.equal(restored.rows.get("d")?.refinement, "fallback");
  assert.equal(restored.rows.get("d")?.streaming?.text, "Stream only");
});

test("reading proposals must cover their window and preserve source identities", () => {
  const plan = validateArrangement(turns, rows, "zh")!;
  const layout = new ReadingLayout([plan]);
  assert.deepEqual(layout.order(["a", "b", "c", "d"]), ["b", "a", "d"]);
  assert.deepEqual(layout.editable(["b", "c", "d"]), ["d"]);
  assert.equal(
    layout.replace({
      sourceIds: ["c", "d"],
      turns: [{ ids: ["d", "c"], text: "Outside" }],
    }),
    false,
  );
  assert.deepEqual(layout.turn("c")?.ids, ["a", "c"]);
  for (const bad of [
    [{ ids: ["a"] }],
    [{ ids: ["a", "a"] }, { ids: ["b", "c"] }],
    [{ ids: ["other"] }, ...turns],
    [
      { ids: ["b", "a"], text: "Crossed speakers", translation: "T" },
      { ids: ["c"] },
    ],
    [{ ids: ["b"] }, { ids: ["a", "c"], text: "Missing translation" }],
  ])
    assert.equal(validateArrangement(bad, rows, "zh"), undefined);
  assert.equal(
    validateArrangement(
      turns,
      [rows[0], rows[1], { ...rows[2], language: "de" }],
      "zh",
    ),
    undefined,
  );
  assert.equal(
    validateArrangement(
      turns,
      [
        rows[0],
        rows[1],
        {
          ...rows[2],
          spans: [{ speaker: "S1", start: 1, end: 2, overlap: true }],
        },
      ],
      "zh",
    ),
    undefined,
  );
  layout.replace({
    sourceIds: ["a", "b", "c"],
    turns: rows.map((s) => ({ ids: [s.id] })),
  });
  assert.deepEqual(layout.order(["a", "b", "c"]), ["a", "b", "c"]);
});

test("a changed source during an AI request prevents stale grouping", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-layout-stale-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = new Journal(dir);
  for (const s of rows) log.emit({ kind: "segment", segment: s });
  const ctx = makeContext(rows, "c", {}, "zh", log.reading)!;
  log.emit({
    kind: "segment",
    segment: { ...rows[0], revision: 2, raw: "Corrected speech" },
  });
  const reply = {
    updates: rows.map((s) => ({
      id: s.id,
      revision: s.revision,
      text: "New " + s.id,
      translation: "T",
    })),
    turns,
  };
  applyRevision(log, ctx, rows[2], JSON.stringify(reply), () => true);
  assert.deepEqual(log.reading.order(["a", "b", "c"]), ["a", "b", "c"]);
  assert.equal(log.rows.get("a")?.raw, "Corrected speech");
  assert.equal(log.rows.get("a")?.edited, undefined);
  assert.equal(log.rows.get("c")?.edited, "New c");
  await log.flush();
});

test("organizing an old meeting atomically publishes edited sources, merged prose and reading order", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-organize-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = new Projects(dir).all[0],
    meeting = project.meetings[0],
    journal = new Journal(join(dir, "conversation"));
  for (const row of rows) {
    journal.emit({
      kind: "segment",
      segment: { ...row, stage: "stream", raw: "Live " + row.id },
    });
    journal.emit({
      kind: "segment",
      segment: {
        ...row,
        refinement: "recognized",
        reviewed: true,
        edited: "Old " + row.id,
        translation: "Old translation",
      },
    });
  }
  const since = journal.seq;
  let calls = 0;
  const editor = new Editor(
    {
      info: async () => ({ ready: true, models: [], reason: "ready" }),
      run: async (message) => {
        calls++;
        const ctx = JSON.parse(message);
        assert.deepEqual(ctx.arrangeableIds, ["a", "b", "c"]);
        assert.equal(ctx.translationTarget, "zh");
        return {
          usage: { ...emptyUsage(), requests: 1, total: 15 },
          text: JSON.stringify({
            updates: rows.map((s) => ({
              id: s.id,
              revision: s.revision,
              text: "Edited " + s.id,
              translation: "Translated " + s.id,
            })),
            turns,
          }),
        };
      },
    },
    () => {},
  );
  t.after(() => editor.shutdown());
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Revision did not complete")),
      4000,
    );
    journal.listeners.add(({ change }) => {
      if (change.kind === "ai" && ["idle", "failed"].includes(change.status)) {
        clearTimeout(timer);
        if (change.status === "failed")
          reject(Error("Unexpected revision failure"));
        else resolve();
      }
    });
  });
  editor.organize(meeting, journal);
  await done;
  await journal.export();
  assert.equal(calls, 1);
  assert.equal(
    journal
      .since(journal.epoch, since)
      ?.filter((p) => p.change.kind === "revision").length,
    1,
  );
  const restored = new Journal(journal.directory);
  assert.deepEqual(
    restored.snapshot().segments.map((s) => s.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(restored.reading.order(["a", "b", "c"]), ["b", "a"]);
  assert.equal(restored.reading.turn("c")?.translation, "Translated turn.");
  assert.equal(restored.rows.get("c")?.streaming?.text, "Live c");
  assert.equal(restored.rows.get("c")?.edited, "Edited c");
  const md = await readFile(journal.markdown, "utf8");
  assert(md.indexOf("Edited b") < md.indexOf("Joined turn."));
  assert.match(md, /> 00:00:03 · Original c/);
  restored.emit({
    kind: "segment",
    segment: { ...restored.rows.get("c")!, speaker: "S3" },
  });
  assert.deepEqual(restored.reading.order(["a", "b", "c"]), ["a", "b", "c"]);
  await restored.flush();
});
