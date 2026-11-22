import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  appendFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Projects } from "../modules/projects/repository.ts";
import { Journal } from "../modules/transcripts/journal.ts";
import { makeContext } from "../modules/ai-editing/context.ts";
import { Editor } from "../modules/ai-editing/editor.ts";
import {
  emptyUsage,
  type AgentHarness,
} from "../modules/agent-runtime/types.ts";
import type { Segment } from "../modules/transcripts/types.ts";

const row = (n: number): Segment => ({
  id: String(n),
  start: n * 1000,
  end: n * 1000 + 800,
  raw: "Utterance " + n,
  stage: "final",
  language: "en",
  speaker: "S1",
  revision: 1,
});
test("projects persist independent sessions, defaults and local storage locations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-projects-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = new Projects(dir);
  assert.equal(repo.all[0].defaults.language, "de");
  assert.equal(repo.all[0].meetings[0].settings.language, "de");
  const project = repo.create({
    name: "Design review",
    folder: dir,
    defaults: { language: "en" },
  });
  assert.equal(project.meetings.length, 1);
  const first = project.meetings[0],
    second = repo.add(project.id);
  assert.equal(first.settings.language, "en");
  repo.configure(first, { language: "zh" });
  assert.equal(second.settings.language, "en");
  const restored = new Projects(dir).project(project.id);
  assert.equal(restored.defaults.language, "en");
  assert.equal(restored.meetings.length, 2);
  assert.equal(restored.meetings[1].settings.language, "zh");
  assert.ok(
    repo
      .directory(project, second)
      .startsWith(join(dir, "MeetingDesk", project.name)),
  );
});
test("legacy mixed recordings migrate to direct playback and remember independent input selections", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-inputs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = new Projects(dir).all[0];
  const legacy = {
    source: "both",
    application: "example.meeting",
    translate: false,
  };
  await writeFile(
    join(dir, "projects.json"),
    JSON.stringify({
      version: 2,
      projects: [
        {
          ...first,
          defaults: { source: "mic" },
          meetings: [{ ...first.meetings[0], settings: legacy }],
        },
      ],
    }),
  );
  const repo = new Projects(dir);
  const project = repo.project(first.id);
  const meeting = project.meetings[0];
  assert.equal(meeting.settings.source, "system");
  assert.equal(meeting.settings.application, legacy.application);
  assert.equal(meeting.settings.translate, false);
  assert.equal(repo.add(project.id).settings.source, "mic");
  repo.configure(meeting, {
    source: "mic",
    inputDevice: "aggregate",
    inputChannel: 3,
  });
  const saved = new Projects(dir).find(meeting.id).meeting;
  assert.equal(saved.settings.inputDevice, "aggregate");
  assert.equal(saved.settings.inputChannel, 3);
  assert.throws(() => repo.configure(meeting, { inputChannel: 0 }));
  assert.equal(meeting.settings.inputChannel, 3);
  repo.configure(meeting, { inputDevice: "other" });
  assert.equal(meeting.settings.inputChannel, 1);
  assert.equal(repo.create({}).meetings[0].settings.source, "system");
});
test("journal recovers drafts, speaker names, usage and a truncated last event", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const j = new Journal(dir);
  j.setState("recording");
  j.emit({ kind: "segment", segment: { ...row(1), stage: "partial" } });
  j.emit({ kind: "speaker", id: "S1", name: "Alice" });
  j.addUsage({
    ...emptyUsage(),
    input: 15,
    output: 7,
    total: 22,
    requests: 1,
    context: 22,
    window: 1000,
  });
  await j.flush();
  await appendFile(j.path, '{"seq":100');
  const restored = new Journal(dir);
  assert.equal(restored.state, "interrupted");
  assert.equal(restored.rows.get("1")?.stage, "interrupted");
  assert.equal(restored.names.S1, "Alice");
  assert.equal(restored.usage.total, 22);
  restored.emit({ kind: "segment", segment: row(2) });
  await restored.export();
  assert.match(await readFile(restored.markdown, "utf8"), /Alice/);
  for (const line of (await readFile(j.path, "utf8")).trim().split("\n"))
    assert.ok(JSON.parse(line).change);
});
test("failed writes can retry without losing or duplicating an utterance", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const j = new Journal(dir);
  await rename(j.path, j.path + ".hold");
  j.emit({ kind: "segment", segment: row(1) });
  await assert.rejects(j.flush());
  await rename(j.path + ".hold", j.path);
  await j.flush();
  const lines = (await readFile(j.path, "utf8"))
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  assert.equal(lines.filter((p) => p.change.kind === "segment").length, 1);
  assert.equal(j.notice, null);
});
test("context contains twelve finalized turns with only the last three editable", () => {
  const rows = Array.from({ length: 42 }, (_, i) => row(i + 1));
  rows.splice(40, 0, { ...row(100), stage: "partial" });
  const context = makeContext(rows, "42", { S1: "Alice" }, "zh")!;
  assert.deepEqual(
    context.reference.map((s) => s.id),
    ["31", "32", "33", "34", "35", "36", "37", "38", "39"],
  );
  assert.deepEqual(
    context.editable.map((s) => s.id),
    ["40", "41", "42"],
  );
  assert.equal(context.reference[0].speaker, "Alice");
});
test("AI patches cannot change reference turns and provider usage is counted exactly once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-editor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const p = new Projects(dir).all[0],
    m = p.meetings[0];
  m.settings.translate = true;
  const log = new Journal(join(dir, "journal"));
  for (let n = 1; n <= 12; n++)
    log.emit({
      kind: "segment",
      segment: {
        ...row(n),
        reviewed: n <= 9,
        translation: n <= 9 ? "Translated" : undefined,
      },
    });
  let calls = 0;
  const harness: AgentHarness = {
    info: async () => ({ ready: true, models: [], reason: "ready" }),
    run: async (message) => {
      calls++;
      const ctx = JSON.parse(message);
      const updates = [...ctx.reference, ...ctx.editable].map(
        (r: { id: string; revision: number }) => ({
          id: r.id,
          revision: r.revision,
          text: "Edited " + r.id,
          translation: "Translation",
        }),
      );
      return {
        text: JSON.stringify({ updates }),
        usage: {
          ...emptyUsage(),
          input: 12,
          output: 3,
          cacheRead: 4,
          total: 19,
          requests: 1,
          context: 19,
          window: 1000,
        },
      };
    },
  };
  const editor = new Editor(harness, () => {});
  const complete = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Editor did not settle")),
      5000,
    );
    log.listeners.add(({ change }) => {
      if (change.kind === "ai" && change.status === "idle" && calls) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  editor.enqueue(m, log);
  await complete;
  await log.export();
  assert.equal(calls, 1);
  assert.equal(log.rows.get("9")?.edited, undefined);
  assert.equal(log.rows.get("10")?.edited, "Edited 10");
  assert.equal(log.rows.get("10")?.raw, "Utterance 10");
  assert.equal(log.usage.total, 19);
  assert.equal(log.usage.cacheRead, 4);
  assert.equal(log.usage.context, 19);
});

test("reconnecting readers receive only missing events and fall back after a different server epoch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-resume-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = new Journal(dir);
  log.emit({ kind: "segment", segment: row(1) });
  const seen = log.seq;
  log.emit({ kind: "speaker", id: "S1", name: "Alice" });
  assert.deepEqual(
    log.since(log.epoch, seen)?.map((p) => p.change.kind),
    ["speaker"],
  );
  assert.equal(log.since("previous-process", seen), null);
  for (let i = 0; i < 513; i++)
    log.emit({
      kind: "segment",
      segment: { ...row(2), stage: "partial", raw: String(i) },
    });
  assert.equal(log.since(log.epoch, seen), null);
  await log.flush();
});

test("a delayed AI response preserves a newer text revision and still records its usage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-stale-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const meeting = new Projects(dir).all[0].meetings[0],
    log = new Journal(join(dir, "journal"));
  meeting.settings.translate = false;
  log.emit({ kind: "segment", segment: row(1) });
  let release!: () => void, started!: () => void;
  const start = new Promise<void>((r) => {
      started = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const editor = new Editor(
    {
      info: async () => ({ ready: true, models: [], reason: "ready" }),
      run: async () => {
        started();
        await gate;
        return {
          text: JSON.stringify({
            updates: [{ id: "1", revision: 1, text: "Obsolete" }],
          }),
          usage: { ...emptyUsage(), requests: 1, input: 10, total: 10 },
        };
      },
    },
    () => {},
  );
  editor.enqueue(meeting, log);
  await start;
  log.emit({
    kind: "segment",
    segment: { ...row(1), revision: 2, edited: "Confirmed", reviewed: true },
  });
  const settled = new Promise<void>((resolve) => {
    const listener = () => {
      if (log.usage.total && log.aiStatus === "idle") {
        log.listeners.delete(listener);
        resolve();
      }
    };
    log.listeners.add(listener);
  });
  release();
  await settled;
  await log.export();
  assert.equal(log.rows.get("1")?.edited, "Confirmed");
  assert.equal(log.usage.total, 10);
});
