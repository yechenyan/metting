import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiHarness } from "../modules/agent-runtime/pi/rpc.ts";
import type { AgentActivity } from "../modules/agent-runtime/activity.ts";

test("Pi continues a native tool session, bills each turn once and resets only the transcription agent", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "meeting-native-pi-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const fixture = await readFile(
    new URL("./fixtures/pi-rpc.mjs", import.meta.url),
    "utf8",
  );
  const node = join(base, "pi-fixture.mjs"),
    log = join(base, "calls.jsonl");
  await writeFile(node, "#!" + process.execPath + "\n" + fixture, {
    mode: 0o700,
  });
  process.env.MEETING_DESK_NODE = node;
  process.env.PI_FIXTURE_LOG = log;
  const models = [{ id: "test/model", label: "Test", levels: ["low"] }];
  const catalog = {
    info: async () => ({ ready: true, reason: "ready", models }),
  };
  const chat = new PiHarness("Meeting questions", catalog);
  const editor = new PiHarness("Transcript revision", catalog);
  t.after(() => {
    chat.close();
    editor.close();
  });
  const cwd = join(base, "project");
  await mkdir(cwd);
  const conversation = {
    directory: base,
    workingDirectory: cwd,
    initialPrompt: () => "Imported prior exchange and first question",
  };
  const steps: AgentActivity[] = [];
  const progress: number[] = [];
  const options = {
    signal: new AbortController().signal,
    conversation,
    activity: (step: AgentActivity) => steps.push(step),
  };
  const preview = (tokens: number) => progress.push(tokens);
  const first = await chat.run("First", "", "low", preview, options);
  const next = await chat.run("Follow-up", "", "low", preview, options);
  assert.deepEqual([first.text, next.text], ["Turn 1", "Turn 2"]);
  assert.deepEqual(
    [first.usage.total, next.usage.total, next.usage.requests],
    [14, 14, 2],
  );
  assert.deepEqual(
    steps.map((step) => step.status),
    ["running", "done", "running", "done"],
  );
  assert.ok(
    steps[1].kind === "tool" &&
      steps[1].target === "pwd" &&
      steps[1].output === "workspace",
  );
  assert.deepEqual(progress, [5, 14, 5, 14]);
  for (const sentence of ["One", "Two"])
    assert.equal(
      (await editor.run(sentence, "", "low", preview)).text,
      "Turn 1",
    );
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const processes = calls.filter((entry) => entry.argv);
  assert.equal(processes.length, 2);
  const [qa, revision] = processes;
  assert.equal(qa.cwd, await realpath(cwd));
  assert.equal(
    qa.argv[qa.argv.indexOf("--session") + 1],
    join(base, "pi-session.jsonl"),
  );
  assert.equal(qa.argv[qa.argv.indexOf("--tools") + 1], "*");
  assert.ok(qa.argv.includes("--append-system-prompt"));
  assert.ok(
    !qa.argv.some(
      (option: string) =>
        option.startsWith("--no-") || option === "--extension",
    ),
  );
  assert.ok(
    revision.argv.includes("--no-tools") &&
      revision.argv.includes("--no-session"),
  );
  assert.deepEqual(
    calls
      .filter((entry) => entry.type === "new_session")
      .map((entry) => entry.pid),
    [revision.pid, revision.pid],
  );
  assert.deepEqual(
    calls
      .filter((entry) => entry.type === "prompt" && entry.pid === qa.pid)
      .map((entry) => entry.message),
    [conversation.initialPrompt(), "Follow-up"],
  );
});
