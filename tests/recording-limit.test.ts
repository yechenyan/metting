import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Editor } from "../modules/ai-editing/editor.ts";
import type { AgentHarness } from "../modules/agent-runtime/types.ts";
import { Meetings } from "../modules/meetings/service.ts";
import { Projects } from "../modules/projects/repository.ts";
import type { SpeechCallbacks } from "../modules/speech/local.ts";
import { Journal } from "../modules/transcripts/journal.ts";
import type { Segment } from "../modules/transcripts/types.ts";

test("new and existing projects persist a validated maximum duration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meeting-duration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let projects = new Projects(directory);
  const { maxRecordingMinutes, ...legacy } = projects.all[0];
  assert.equal(maxRecordingMinutes, 180);
  const file = join(directory, "projects.json");
  await writeFile(file, JSON.stringify({ version: 4, projects: [legacy] }));
  projects = new Projects(directory);
  assert.deepEqual(projects.project(legacy.id), {
    ...legacy,
    maxRecordingMinutes: 180,
  });
  const custom = projects.create({ maxRecordingMinutes: 75 });
  projects.editProject(custom.id, "Renamed", {});
  assert.equal(custom.maxRecordingMinutes, 75);
  projects.editProject(custom.id, "Renamed", {}, 45);
  for (const value of [
    0,
    -3,
    0.5,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    null,
    "45",
  ]) {
    assert.throws(() =>
      projects.editProject(custom.id, "Invalid", {}, value as number),
    );
    assert.throws(() =>
      projects.create({ maxRecordingMinutes: value as number }),
    );
  }
  assert.equal(
    new Projects(directory).project(custom.id).maxRecordingMinutes,
    45,
  );
});

async function setup(t: TestContext, run?: AgentHarness["run"]) {
  const directory = await mkdtemp(join(tmpdir(), "meeting-cutoff-"));
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.UTC(2026, 0, 1),
  });
  const projects = new Projects(directory);
  const project = projects.all[0],
    first = project.meetings[0];
  const editor = new Editor(
    {
      info: async () => ({ ready: true, reason: "ready", models: [] }),
      run:
        run ??
        (async () => {
          throw new Error("Unexpected AI request");
        }),
    },
    () => {},
  );
  const captures: SpeechCallbacks[] = [];
  const offsets: number[] = [];
  let stops = 0;
  const meetings = new Meetings(
    projects,
    editor,
    () => {},
    () => {},
    (_language, callbacks) => {
      captures.push(callbacks);
      return {
        prepare: (_settings, _directory, offset) => {
          offsets.push(offset);
        },
        startCapture: () => callbacks.ready(),
        stop: () => {
          stops++;
        },
        force: () => callbacks.end(null),
      };
    },
  );
  t.after(async () => {
    editor.shutdown();
    captures.at(-1)?.end(null);
    await meetings.close();
    for (const meeting of project.meetings)
      await meetings.journal(meeting.id).export();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    projects,
    project,
    first,
    meetings,
    offsets,
    capture: () => captures.at(-1)!,
    stops: () => stops,
    journal: meetings.journal(first.id),
    changeLimit: (minutes: number) => {
      projects.editProject(project.id, project.name, {}, minutes);
      meetings.limitChanged(project);
    },
  };
}

test("resuming after an interruption starts after all the saved audio, including untranscribed silence", async (t) => {
  const { projects, project, meetings, offsets } = await setup(t);
  const meeting = projects.add(project.id);
  const directory = projects.directory(project, meeting);
  const previous = new Journal(directory);
  previous.setState("recording", null, 4800);
  await previous.flush();
  const audio = join(directory, "audio");
  await mkdir(audio);
  await writeFile(
    join(audio, "000000004750-" + "c".repeat(32) + ".wav"),
    Buffer.alloc(44 + 32_000),
  );
  const recovered = meetings.journal(meeting.id);
  assert.equal(recovered.state, "interrupted");
  assert.equal(recovered.time(), 5750);
  meetings.prepare(meeting.id);
  assert.equal(offsets.at(-1), 5750);
});

test("the server stops a silent recording at three cumulative hours with no browser attached", async (t) => {
  const {
    first,
    journal,
    projects,
    project,
    meetings,
    offsets,
    capture,
    stops,
  } = await setup(t);
  const hour = 3_600_000;
  meetings.start(first.id);
  t.mock.timers.tick(hour);
  await journal.flush();
  const copy = await mkdtemp(join(journal.directory, "recovery-"));
  await copyFile(journal.path, join(copy, "transcript.jsonl"));
  const recovered = new Journal(copy);
  assert.equal(recovered.state, "interrupted");
  assert.equal(recovered.time(), hour);
  await recovered.flush();
  meetings.stop(first.id);
  capture().end(null);
  t.mock.timers.tick(5 * hour);
  assert.equal(journal.time(), hour);
  meetings.start(first.id);
  assert.deepEqual(offsets, [0, hour]);
  t.mock.timers.tick(2 * hour - 1);
  assert.equal(journal.state, "recording");
  t.mock.timers.tick(1);
  assert.equal(journal.state, "stopping");
  assert.equal(stops(), 2);
  capture().end(null);
  assert.equal(journal.time(), 3 * hour);
  assert.equal(journal.notice?.code, "recordingLimitReached");
  assert.throws(() => meetings.start(first.id), /duration limit/);
  await journal.export();
  assert.equal(new Journal(journal.directory).time(), 3 * hour);
  const sibling = projects.add(project.id);
  meetings.start(sibling.id);
  assert.equal(meetings.journal(sibling.id).state, "recording");
  assert.equal(offsets.at(-1), 0);
});

test("changing the active limit reschedules the cutoff and preserves elapsed time", async (t) => {
  const { first, journal, meetings, changeLimit, capture, stops } =
    await setup(t);
  changeLimit(1);
  meetings.start(first.id);
  t.mock.timers.tick(59_000);
  changeLimit(3);
  t.mock.timers.tick(62_000);
  assert.equal(stops(), 0);
  changeLimit(2);
  assert.equal(stops(), 1);
  capture().ready();
  meetings.stop(first.id);
  assert.equal(stops(), 1);
  capture().end(null);
  assert.equal(journal.time(), 121_000);
  assert.throws(() => meetings.start(first.id), /duration limit/);
  changeLimit(3);
  meetings.start(first.id);
  t.mock.timers.tick(59_000);
  assert.equal(stops(), 2);
});

test("expiry cancels automatic AI work while saving final sentences drained from the capture worker", async (t) => {
  let began!: () => void,
    requests = 0;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let signal: AbortSignal | undefined;
  const { first, journal, meetings, changeLimit, capture } = await setup(
    t,
    async (_message, _model, _thinking, _preview, options) => {
      requests++;
      signal = options!.signal;
      began();
      return await new Promise((_resolve, reject) => {
        signal!.addEventListener(
          "abort",
          () => reject(new Error("Cancelled")),
          { once: true },
        );
      });
    },
  );
  const firstRow: Segment = {
    id: "first",
    start: 0,
    end: 500,
    raw: "First sentence",
    language: "en",
    stage: "final",
    speaker: "S1",
    revision: 1,
  };
  changeLimit(1);
  journal.setState("idle", null, 58_000);
  meetings.start(first.id);
  capture().segment(firstRow);
  t.mock.timers.tick(650);
  await started;
  capture().segment({ ...firstRow, id: "queued" });
  t.mock.timers.tick(1_350);
  assert.equal(signal?.aborted, true);
  capture().segment({ ...firstRow, id: "last", raw: "Last sentence" });
  capture().end(null);
  meetings.enqueueEditing(first.id, true);
  t.mock.timers.tick(5_000);
  await journal.export();
  assert.equal(requests, 1);
  assert.equal(journal.notice?.code, "recordingLimitReached");
  assert.match(await readFile(journal.markdown, "utf8"), /Last sentence/);
});
