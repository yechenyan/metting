import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Projects } from "../modules/projects/repository.ts";
import { Editor } from "../modules/ai-editing/editor.ts";
import { emptyUsage } from "../modules/agent-runtime/types.ts";
import { Journal } from "../modules/transcripts/journal.ts";
import { turnTranslation } from "../modules/transcripts/reading.ts";
import {
  translatedText,
  translationSettings,
  translationTarget,
} from "../modules/transcripts/translation.ts";
import type { Segment } from "../modules/transcripts/types.ts";

test("projects persist translation defaults and legacy recordings retain their own enabled state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-translation-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = new Projects(dir).all[0];
  const registry = {
    version: 3,
    projects: [
      {
        ...old,
        defaults: { translate: true },
        meetings: [{ ...old.meetings[0], settings: { translate: false } }],
      },
    ],
  };
  await writeFile(join(dir, "projects.json"), JSON.stringify(registry));
  const repo = new Projects(dir);
  assert.equal(translationTarget(repo.project(old.id).defaults), "zh");
  assert.equal(
    translationTarget(repo.find(old.meetings[0].id).meeting.settings),
    null,
  );
  const project = repo.create({ defaults: translationSettings("de") });
  assert.equal(translationTarget(project.meetings[0].settings), "de");
  repo.editProject(project.id, project.name, translationSettings(null));
  const reopened = new Projects(dir);
  assert.equal(translationTarget(reopened.add(project.id).settings), null);
  assert.equal(
    translationTarget(reopened.find(project.meetings[0].id).meeting.settings),
    "de",
  );
});

test(
  "an in-flight result for an old target cannot overwrite the selected language",
  { timeout: 7000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "meeting-translation-change-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const repo = new Projects(dir),
      meeting = repo.all[0].meetings[0];
    const journal = new Journal(join(dir, "recording"), () =>
      translationTarget(meeting.settings),
    );
    journal.emit({
      kind: "segment",
      segment: {
        id: "a",
        raw: "Guten Morgen",
        speaker: "S1",
        stage: "final",
        start: 0,
        end: 900,
        language: "de",
        revision: 1,
      },
    });
    let started!: () => void, release!: () => void, complete!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      started = resolve;
    });
    const firstResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saved = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const targets: string[] = [];
    const editor = new Editor(
      {
        info: async () => ({ ready: true, models: [], reason: "ready" }),
        run: async (message) => {
          const ctx = JSON.parse(message);
          targets.push(ctx.translationTarget);
          if (targets.length === 1) {
            started();
            await firstResponse;
          }
          return {
            usage: { ...emptyUsage(), requests: 1, total: 8 },
            text: JSON.stringify({
              updates: [
                {
                  id: "a",
                  revision: ctx.editable[0].revision,
                  text: "Guten Morgen.",
                  translation:
                    ctx.translationTarget === "en"
                      ? "Good morning."
                      : "Stale reply",
                },
              ],
            }),
          };
        },
      },
      () => {},
    );
    t.after(() => editor.shutdown());
    const writes: string[] = [];
    journal.listeners.add(({ change }) => {
      if (change.kind === "revision") {
        writes.push(change.segments[0].translation!);
        complete();
      }
    });
    editor.enqueue(meeting, journal);
    await firstCall;
    repo.configure(meeting, translationSettings("en"));
    editor.enqueue(meeting, journal, true);
    release();
    await saved;
    await journal.export();
    assert.deepEqual(targets, ["zh", "en"]);
    assert.deepEqual(writes, ["Good morning."]);
    assert.equal(journal.usage.requests, 2);
    const row = new Journal(journal.directory).rows.get("a");
    assert.equal(translatedText(row, "en"), "Good morning.");
    assert.equal(translatedText(row, "zh"), undefined);
    assert.match(await readFile(journal.markdown, "utf8"), /Good morning/);
    repo.configure(meeting, translationSettings(null));
    await journal.export();
    assert.doesNotMatch(
      await readFile(journal.markdown, "utf8"),
      /Good morning/,
    );
  },
);

test("merged translations use one language and recognize untagged Chinese journals", () => {
  const row: Segment = {
    id: "a",
    raw: "Hallo",
    speaker: "S1",
    language: "de",
    stage: "final",
    start: 0,
    end: 100,
    revision: 1,
    translation: "Legacy",
  };
  const rows = new Map<string, Segment>([
    ["a", row],
    ["b", { ...row, id: "b", translation: "Second" }],
  ]);
  const turn = { ids: ["a", "b"], translation: "Legacy merged text" };
  assert.equal(turnTranslation(turn, rows, "zh"), turn.translation);
  assert.equal(turnTranslation(turn, rows, "en"), undefined);
  rows.set("a", { ...row, translation: "Hello.", translationLanguage: "en" });
  assert.equal(turnTranslation(turn, rows, "en"), undefined);
  rows.set("b", {
    ...row,
    id: "b",
    translation: "Welcome.",
    translationLanguage: "en",
  });
  assert.equal(turnTranslation(turn, rows, "en"), "Hello. Welcome.");
  assert.equal(turnTranslation(turn, rows, null), undefined);
});
