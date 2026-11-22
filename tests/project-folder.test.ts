import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Projects } from "../modules/projects/repository.ts";
import { bindSessionDirectory } from "../modules/agent-runtime/pi/session.ts";
import { ChatService } from "../modules/chat/service.ts";
import { emptyUsage } from "../modules/agent-runtime/types.ts";
import { Journal } from "../modules/transcripts/journal.ts";
import type { ChatRequest } from "../modules/chat/types.ts";

test("relinking a legacy project preserves live and stored recording paths and applies to each new question", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "meeting-relink-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const first = join(base, "first"),
    second = join(base, "second");
  await Promise.all([mkdir(first), mkdir(second)]);
  const registry = join(base, "projects.json");
  const prior = new Projects(base).create({ folder: first });
  const { storageFolder: _oldFolder, ...legacyMeeting } = prior.meetings[0];
  await writeFile(
    registry,
    JSON.stringify({
      version: 5,
      projects: [{ ...prior, meetings: [legacyMeeting] }],
    }),
  );
  const projects = new Projects(base);
  const project = projects.project(prior.id),
    meeting = project.meetings[0];
  const directory = projects.directory(project, meeting);
  const journal = new Journal(directory);
  journal.setState("recording");
  const scopes: (string | undefined)[] = [];
  let started!: () => void, release!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chat = new ChatService(
    () => projects.stateDirectory(project, meeting),
    () => journal,
    () => ({
      info: async () => ({ ready: true, reason: "ready", models: [] }),
      run: async (prompt, _model, _thinking, _usage, options) => {
        scopes.push(options?.conversation?.workingDirectory);
        if (scopes.length === 1) {
          started();
          await gate;
        }
        const answer = JSON.parse(prompt).projectFolder || "Meeting only";
        return { text: answer, usage: emptyUsage() };
      },
    }),
    (id) => projects.chatWorkspace(id),
  );
  const room = await chat.room(meeting.id);
  const ask = () => {
    const question: ChatRequest = {
      id: crypto.randomUUID(),
      question: "Which folder?",
      reference: null,
      model: "",
      thinking: "low",
    };
    let done!: () => void;
    const settled = new Promise<void>((resolve) => {
      done = resolve;
    });
    const detach = room.subscribe((event) => {
      if (
        event.kind === "turn" &&
        event.turn.id === question.id &&
        event.turn.status === "complete"
      )
        done();
    });
    return room
      .submit(question)
      .then(() => settled)
      .finally(detach);
  };
  const firstAnswer = ask();
  await firstStarted;
  projects.editProject(project.id, project.name, {}, undefined, second);
  release();
  await firstAnswer;
  assert.equal(projects.directory(project, meeting), directory);
  assert.ok(
    projects.directory(project, projects.add(project.id)).startsWith(second),
  );
  assert.throws(
    () => projects.editProject(project.id, "Rejected", {}, undefined, registry),
    /Invalid project folder/,
  );
  assert.equal(project.folder, second);
  assert.equal(new Projects(base).project(project.id).folder, second);
  await ask();
  projects.editProject(project.id, project.name, {}, undefined, "");
  await ask();
  const workspace = projects.chatWorkspace(meeting.id);
  assert.deepEqual(scopes, [first, second, workspace]);
  assert.ok((await stat(workspace)).isDirectory());
  await chat.close();
  journal.setState("idle", null, 5000);
  await journal.flush();
  const restored = new Projects(base);
  const saved = restored.find(meeting.id);
  const originalDirectory = restored.directory(saved.project, saved.meeting);
  assert.equal(new Journal(originalDirectory).time(), 5000);
  const turns = (
    await readFile(
      join(restored.stateDirectory(saved.project, saved.meeting), "chat.jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  assert.deepEqual(
    turns.filter((v) => v.status === "complete").map((v) => v.answer),
    ["first", "second", "workspace"],
  );
  assert.equal(restored.add(project.id).storageFolder, "");
});

test("relinking a native Pi session preserves its identity and complete tool history", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "meeting-pi-cwd-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, "pi-session.jsonl");
  const cwd = join(base, "new");
  await bindSessionDirectory(file, cwd);
  const header = {
    type: "session",
    id: crypto.randomUUID(),
    version: 3,
    cwd: base,
  };
  const entry =
    JSON.stringify({
      type: "message",
      message: { role: "toolResult", text: "Ü".repeat(80000) },
    }) + "\n";
  const branch = entry + '{"type":"label"}\n';
  await writeFile(file, JSON.stringify(header) + "\n" + branch);
  await bindSessionDirectory(file, cwd);
  assert.equal(
    await readFile(file, "utf8"),
    JSON.stringify({ ...header, cwd }) + "\n" + branch,
  );
  const inode = (await stat(file)).ino;
  await bindSessionDirectory(file, cwd);
  assert.equal((await stat(file)).ino, inode);
  await writeFile(file, "partial");
  await assert.rejects(bindSessionDirectory(file, cwd), /Incomplete/);
  assert.equal(await readFile(file, "utf8"), "partial");
});
