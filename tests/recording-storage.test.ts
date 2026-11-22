import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { readAudioParts } from "../modules/audio/archive.ts";
import { audioFilename } from "../modules/audio/filenames.ts";
import { defaultRecordingName } from "../modules/meetings/names.ts";
import { Projects, defaultSettings } from "../modules/projects/repository.ts";
import { RecordingStorage } from "../modules/projects/storage.ts";
import { Journal } from "../modules/transcripts/journal.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "meeting-layout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function write(path: string, value: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

test("legacy recordings migrate to named files on their original volumes and keep their audio timeline and chat", async (t) => {
  const base = await fixture(t),
    linked = join(base, "linked"),
    id = randomUUID();
  const records = [linked, ""].map((storageFolder) => ({
    id: randomUUID(),
    created: new Date().toISOString(),
    storageFolder,
    settings: defaultSettings,
  }));
  write(
    join(base, "projects.json"),
    JSON.stringify({
      version: 6,
      projects: [
        {
          id,
          name: "Review 09:30",
          folder: linked,
          created: records[0].created,
          meetings: records,
          defaults: defaultSettings,
          maxRecordingMinutes: 180,
        },
      ],
    }),
  );
  for (const recording of records) {
    const root = recording.storageFolder
      ? join(linked, "MeetingDesk")
      : join(base, "projects");
    const dir = join(root, id, "meetings", recording.id);
    const journal = new Journal(dir);
    journal.setState("idle", null, 8400);
    await journal.flush();
    write(join(dir, "transcript.md"), "Saved notes");
    write(join(dir, "chat.jsonl"), "Saved chat");
    write(join(dir, "voices.json"), "Saved voices");
    for (const [i, key] of ["a", "b"].entries())
      write(
        join(dir, "audio", "000000008400-" + key.repeat(32) + ".wav"),
        Buffer.alloc(60, i + 1),
      );
  }
  const repo = new Projects(base),
    project = repo.project(id);
  for (const [i, recording] of project.meetings.entries()) {
    assert.equal(recording.name, defaultRecordingName(2 - i));
    const dir = repo.directory(project, recording),
      stem = repo.stem(project, recording);
    assert.equal(basename(dirname(dir)), "Review 09-30");
    assert.equal(basename(dir), recording.name);
    assert.equal(new Journal(dir).time(), 8400);
    assert.equal(readFileSync(join(dir, stem + ".md"), "utf8"), "Saved notes");
    const audio = readAudioParts(dir, stem);
    assert.deepEqual(
      audio.map((a) => [a.start, a.frames, readFileSync(a.file)[44]]),
      [
        [8400, 8, 1],
        [8400, 8, 2],
      ],
    );
    assert.deepEqual(
      audio.map((a) => basename(a.file)),
      [audioFilename(stem, 8400), audioFilename(stem, 8400, 2)],
    );
    assert.equal(
      readFileSync(
        join(repo.stateDirectory(project, recording), "chat.jsonl"),
        "utf8",
      ),
      "Saved chat",
    );
  }
  const reopened = new Projects(base);
  assert.deepEqual(reopened.project(id), project);
});

test("renaming a recording and project keeps open writers and names later files after the last reader releases", async (t) => {
  const base = await fixture(t),
    repo = new Projects(base),
    p = repo.create({ name: "Design" }),
    m = p.meetings[0];
  const dir = () => repo.directory(p, m),
    stem = () => repo.stem(p, m);
  const journal = new Journal(dir(), undefined, {
    directory: dir,
    stem,
    hold: () => repo.hold(p),
  });
  const original = dir(),
    stable = repo.stateDirectory(p, m);
  write(join(original, "audio", audioFilename(stem(), 0)), Buffer.alloc(64, 7));
  journal.setState("idle", null, 1000);
  await journal.export();
  const capture = repo.hold(p),
    playback = repo.hold(p);
  repo.renameRecording(p.id, m.id, "Kickoff");
  repo.editProject(p.id, "Roadmap", {});
  assert.equal(m.name, "Kickoff");
  assert.equal(dir(), original);
  capture();
  assert.equal(dir(), original);
  playback();
  assert.equal(dir(), join(repo.defaultRoot, "Roadmap", "Kickoff"));
  assert.equal(stable, repo.stateDirectory(p, m));
  assert.ok(!existsSync(original));
  assert.equal(
    readAudioParts(dir())[0].file,
    join(dir(), "audio", audioFilename("Roadmap - Kickoff", 0)),
  );
  journal.setState("idle", null, 2200);
  await journal.export();
  assert.equal(new Journal(dir()).time(), 2200);
  assert.ok(existsSync(join(dir(), "Roadmap - Kickoff.md")));
  assert.equal(new Projects(base).find(m.id).meeting.name, "Kickoff");
});

test("names tolerate separators and collisions without replacing an unrelated file or folder", async (t) => {
  const base = await fixture(t),
    repo = new Projects(base);
  const p = repo.create({ name: "Plan/Next" }),
    first = p.meetings[0];
  const second = repo.add(p.id, first.name);
  assert.equal(second.directoryName, first.name + " (2)");
  assert.equal(
    repo.create({ name: "PLAN:Next" }).directoryName,
    "PLAN-Next (2)",
  );
  const linked = join(base, "linked");
  write(join(linked, "MeetingDesk", p.directoryName, "keep"), "Foreign");
  repo.editProject(p.id, p.name, {}, undefined, linked);
  const extra = repo.add(p.id, "Summary");
  assert.equal(basename(dirname(repo.directory(p, extra))), "Plan-Next (2)");
  assert.equal(
    readFileSync(join(linked, "MeetingDesk", p.directoryName, "keep"), "utf8"),
    "Foreign",
  );
  const dir = repo.directory(p, first);
  write(join(dir, repo.stem(p, first) + ".md"), "Owned");
  write(join(dir, p.directoryName + " - Conflict.md"), "Foreign file");
  assert.throws(
    () => repo.renameRecording(p.id, first.id, "Conflict"),
    /already exists/,
  );
  assert.equal(
    readFileSync(join(dir, repo.stem(p, first) + ".md"), "utf8"),
    "Owned",
  );
  assert.ok(readdirSync(dir).includes(p.directoryName + " - Conflict.md"));
  assert.equal(
    new Projects(base).find(first.id).meeting.name,
    defaultRecordingName(1),
  );
  repo.renameRecording(p.id, first.id, ".. / " + "ä".repeat(90));
  assert.equal(dirname(repo.directory(p, first)), dirname(dir));
  assert.ok(Buffer.byteLength(repo.stem(p, first)) < 200);
  assert.throws(() => repo.renameRecording(p.id, first.id, "   "), /name/);
});

test("reopening a partially applied rename publishes the new registry after all files are in place", async (t) => {
  const base = await fixture(t);
  const repo = new Projects(base);
  const project = repo.create({ name: "Discovery" });
  const recording = project.meetings[0];
  const stem = repo.stem(project, recording);
  write(
    join(repo.directory(project, recording), stem + ".md"),
    "Original notes",
  );
  const next = { ...project, name: "Findings", directoryName: "Findings" };
  const plan = new RecordingStorage(base).rename(project, next);
  const transaction = join(base, ".recording-layout.json");
  write(
    transaction,
    JSON.stringify({
      plan,
      registry: {
        version: 7,
        projects: repo.all.map((p) => (p === project ? next : p)),
      },
    }),
  );
  const first = plan.moves[0];
  renameSync(first.from, first.to);
  const restored = new Projects(base);
  const saved = restored.find(recording.id);
  assert.equal(saved.project.name, next.name);
  const file = join(
    restored.directory(saved.project, saved.meeting),
    restored.stem(saved.project, saved.meeting) + ".md",
  );
  assert.equal(readFileSync(file, "utf8"), "Original notes");
  assert.ok(!existsSync(transaction));
});

test("a failed deferred rename keeps the original files usable and can be retried", async (t) => {
  const repo = new Projects(await fixture(t));
  const p = repo.create({ name: "Conference" }),
    m = p.meetings[0];
  const original = repo.directory(p, m),
    originalFile = join(original, repo.stem(p, m) + ".md");
  write(originalFile, "Transcript");
  const release = repo.hold(p);
  repo.renameRecording(p.id, m.id, "Opening");
  const conflict = join(original, "Conference - Opening.md");
  write(conflict, "Unrelated note");
  assert.throws(release, /already exists/);
  assert.equal(repo.directory(p, m), original);
  assert.equal(readFileSync(originalFile, "utf8"), "Transcript");
  renameSync(conflict, join(original, "personal.md"));
  repo.renameRecording(p.id, m.id, "Opening");
  assert.equal(
    readFileSync(join(repo.directory(p, m), "Conference - Opening.md"), "utf8"),
    "Transcript",
  );
});

test("a reconnected legacy folder keeps an unrelated same-name folder intact", async (t) => {
  const base = await fixture(t);
  const folder = join(base, "external");
  const id = randomUUID(),
    mid = randomUUID(),
    created = new Date().toISOString();
  write(
    join(base, "projects.json"),
    JSON.stringify({
      version: 6,
      projects: [
        {
          id,
          name: "Review",
          folder,
          created,
          defaults: defaultSettings,
          maxRecordingMinutes: 180,
          meetings: [
            {
              id: mid,
              created,
              storageFolder: folder,
              settings: defaultSettings,
            },
          ],
        },
      ],
    }),
  );
  const repo = new Projects(base);
  const { project, meeting } = repo.find(mid);
  assert.throws(() => repo.directory(project, meeting), /offline/);
  const root = join(folder, "MeetingDesk");
  write(join(root, "Review", "keep.txt"), "Unrelated");
  write(join(root, id, "meetings", mid, "transcript.md"), "Recovered notes");
  const dir = repo.directory(project, meeting);
  assert.equal(dir, join(root, "Review (2)", meeting.name));
  const name = "Review (2) - " + meeting.name + ".md";
  assert.equal(readFileSync(join(dir, name), "utf8"), "Recovered notes");
  assert.equal(
    readFileSync(join(root, "Review", "keep.txt"), "utf8"),
    "Unrelated",
  );
  const reopened = new Projects(base),
    saved = reopened.find(mid);
  assert.equal(reopened.directory(saved.project, saved.meeting), dir);
});
