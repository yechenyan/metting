import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateArrangement } from "../modules/ai-editing/arrangement.ts";
import { prepareRecording } from "../modules/chat/recording-context.ts";
import { Journal } from "../modules/transcripts/journal.ts";
import {
  SpeakerNames,
  speakerAssignments,
} from "../modules/transcripts/speaker-names.ts";
import type { Segment } from "../modules/transcripts/types.ts";

function passage(id: string, start: number, speaker = "S1"): Segment {
  return {
    id,
    start,
    end: start + 800,
    speaker,
    language: "en",
    stage: "final",
    revision: 0,
    raw: "Words " + id,
  };
}

test("scoped voice names follow the recording timeline, survive replay and reach exports and chat", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-speakers-"));
  const log = new Journal(dir);
  t.after(async () => {
    await log.flush();
    await rm(dir, { recursive: true, force: true });
  });
  const earlier = passage("early", 1000),
    anchor = passage("anchor", 2000);
  const other = passage("other", 3000, "S2"),
    once = passage("once", 4000);
  const future = passage("future", 6000),
    late = passage("late", 1500);
  log.emit({ kind: "speaker", id: "S1", name: "Previous name" });
  for (const segment of [earlier, anchor, other, once, future])
    log.emit({ kind: "segment", segment });
  const cursor = prepareRecording(log, null).cursor;
  const label = (row: Segment, name: string, following: boolean) =>
    log.emit({
      kind: "speakerAssignment",
      assignments: speakerAssignments(log.rows, {
        ids: [row.id],
        speaker: row.speaker,
        name,
        following,
      }),
    });
  label(anchor, "Ada", true);
  label(once, "Guest", false);
  const delta = prepareRecording(log, null, cursor).evidence.transcript!;
  assert.match(delta, /Ada: Words anchor/);
  assert.match(delta, /Guest: Words once/);
  assert.match(delta, /Ada: Words future/);
  assert.doesNotMatch(delta, /Words (early|other)/);
  log.emit({ kind: "segment", segment: late });
  const next = passage("next", 8000);
  log.emit({
    kind: "segment",
    segment: { ...next, speaker: "unknown", stage: "partial" },
  });
  assert.equal(log.speakerNames.name(log.rows.get(next.id)!), undefined);
  log.emit({ kind: "segment", segment: next });
  assert.equal(log.speakerNames.name(next), "Ada");
  label(future, "Bea", true);
  const names = (registry: SpeakerNames) =>
    [earlier, late, anchor, other, once, future, next].map((row) =>
      registry.name(row),
    );
  const expected = [
    "Previous name",
    "Previous name",
    "Ada",
    undefined,
    "Guest",
    "Bea",
    "Bea",
  ];
  assert.deepEqual(names(log.speakerNames), expected);
  await log.export();
  assert.match(await readFile(log.markdown, "utf8"), /00:00:08 · Bea/);
  const restored = new Journal(dir);
  assert.deepEqual(names(restored.speakerNames), expected);
  const snapshot = restored.snapshot();
  assert.deepEqual(
    names(new SpeakerNames(snapshot.speakers, snapshot.speakerAssignments)),
    expected,
  );
  label(future, "Bea", false);
  assert.equal(log.speakerNames.name(next), "Ada");
  assert.equal(log.speakerNames.name(future), "Bea");
  assert.equal(new SpeakerNames().name(next), undefined);
});

test("unknown and overlapping voices are named locally without confusing speakers or merging distinct names", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-speaker-turns-"));
  const log = new Journal(dir);
  t.after(async () => {
    await log.flush();
    await rm(dir, { recursive: true, force: true });
  });
  const a = passage("a", 1000),
    b = passage("b", 2000);
  const pending = passage("pending", 3000, "unknown"),
    unknown = passage("unknown", 4000, "unknown");
  const spans = ["S1", "S2"].map((speaker) => ({
    start: 5000,
    end: 5600,
    speaker,
    overlap: true,
  }));
  const mixed = { ...passage("mixed", 5000, "unknown"), spans };
  for (const segment of [a, b, pending, unknown, mixed])
    log.emit({ kind: "segment", segment });
  const setName = (
    id: string,
    speaker: string,
    name: string,
    following: boolean,
  ) =>
    log.emit({
      kind: "speakerAssignment",
      assignments: speakerAssignments(log.rows, {
        ids: [id],
        speaker,
        name,
        following,
      }),
    });
  setName(pending.id, "unknown", "Manual", false);
  assert.equal(log.speakerNames.name(unknown), undefined);
  assert.equal(log.speakerNames.name({ ...pending, speaker: "S2" }), "Manual");
  setName(pending.id, "unknown", "Manual", true);
  assert.equal(log.speakerNames.name(unknown), undefined);
  log.emit({ kind: "segment", segment: { ...pending, speaker: "S3" } });
  assert.equal(
    log.speakerNames.name(passage("additional", 7000, "S3")),
    "Manual",
  );
  assert.equal(log.speakerNames.name(unknown), undefined);
  setName(unknown.id, "unknown", "Ambiguous", true);
  log.emit({ kind: "segment", segment: { ...unknown, spans } });
  log.emit({ kind: "segment", segment: { ...unknown, speaker: "S4" } });
  assert.equal(
    log.speakerNames.name(passage("unrelated", 8000, "S4")),
    undefined,
  );
  assert.throws(() => setName(mixed.id, "unknown", "Ambiguous", false));
  assert.throws(() => setName(mixed.id, "S3", "Absent", true));
  const combined = [{ ids: ["a", "b"], text: "A combined turn" }];
  const plan = validateArrangement(combined, [a, b], null, log.speakerNames)!;
  log.emit({ kind: "revision", segments: [a, b], plan });
  assert.deepEqual(log.reading.order(["a", "b"]), ["a"]);
  setName(b.id, "S1", "Guest", false);
  assert.deepEqual(log.reading.order(["a", "b"]), ["a", "b"]);
  assert.equal(
    validateArrangement(combined, [a, b], null, log.speakerNames),
    undefined,
  );
  setName(mixed.id, "S2", "Lea", true);
  assert.equal(log.speakerNames.name(mixed, "S2"), "Lea");
  assert.equal(log.speakerNames.name(mixed, "S1"), undefined);
  assert.equal(log.speakerNames.name(passage("new", 6000, "S2")), "Lea");
});
