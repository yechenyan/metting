import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  audioManifest,
  headerSize,
  maxWaveFrames,
  readAudioParts,
  waveVolumes,
} from "../modules/audio/archive.ts";
import { audioRoute } from "../modules/audio/routes.ts";
import type { Segment } from "../modules/transcripts/types.ts";

test("saved audio supports full playback, exact merged sentence ranges and byte seeks across resumed takes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meeting-audio-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(audioManifest(readAudioParts(directory)).coverage, []);
  const audio = join(directory, "audio");
  await mkdir(audio);
  const samples = (start: number) => {
    const pcm = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) pcm.writeInt16LE(start + i, i * 2);
    return pcm;
  };
  const first = samples(100),
    second = samples(2500);
  for (const [offset, pcm] of [
    [100, first],
    [300, second],
  ] as const) {
    const filename =
      String(offset).padStart(12, "0") + "-" + "a".repeat(32) + ".wav";
    // Zero header sizes simulate interruption before the writer's next checkpoint.
    await writeFile(
      join(audio, filename),
      Buffer.concat([Buffer.alloc(headerSize), pcm]),
    );
  }
  await writeFile(join(audio, "unrelated.wav"), first);
  const parts = readAudioParts(directory);
  const rows = new Map<string, Segment>();
  for (const [id, start, end] of [
    ["old", 0, 100],
    ["a", 101, 104],
    ["b", 103, 105],
    ["c", 302, 306],
    ["tail", 308, 400],
  ] as const) {
    rows.set(id, {
      id,
      start,
      end,
      raw: id,
      speaker: "S1",
      language: "en",
      stage: "final",
      revision: 1,
    });
  }
  const server = createServer((req, res) => {
    const action = req.url!.split("?")[0].slice(1);
    void audioRoute({ req, res, id: "meeting", action }, parts, rows);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = "http://127.0.0.1:" + address.port;
  const info = await (await fetch(url + "/audio-info")).json();
  assert.deepEqual(info.coverage, [
    { start: 100, end: 110 },
    { start: 300, end: 310 },
  ]);
  assert.deepEqual(info.volumeMs, [20]);
  const full = await fetch(url + "/audio");
  const bytes = Buffer.from(await full.arrayBuffer());
  assert.equal(full.headers.get("content-type"), "audio/wav");
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.readUInt32LE(24), 16_000);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.readUInt32LE(40), bytes.length - headerSize);
  assert.deepEqual(bytes.subarray(headerSize), Buffer.concat([first, second]));
  const merged = await fetch(
    url + "/audio?sentence=c&sentence=b&sentence=a&sentence=b",
  );
  const clip = Buffer.from(await merged.arrayBuffer());
  assert.deepEqual(
    clip.subarray(headerSize),
    Buffer.concat([first.subarray(32, 160), second.subarray(64, 192)]),
  );
  assert.equal(clip.readUInt32LE(40), clip.length - headerSize);
  const tail = await fetch(url + "/audio?sentence=tail");
  assert.deepEqual(
    Buffer.from(await tail.arrayBuffer()).subarray(headerSize),
    second.subarray(256),
  );
  for (const id of ["old", "missing"])
    assert.equal((await fetch(url + "/audio?sentence=" + id)).status, 404);
  const head = await fetch(url + "/audio", { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const [range, start, end] of [
    ["bytes=0-1", 0, 1],
    ["bytes=33-51", 33, 51],
    ["bytes=358-370", 358, 370],
    ["bytes=379-", 379, bytes.length - 1],
    ["bytes=-19", bytes.length - 19, bytes.length - 1],
  ] as const) {
    const response = await fetch(url + "/audio", { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(
      response.headers.get("content-range"),
      `bytes ${start}-${end}/${bytes.length}`,
    );
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      bytes.subarray(start, end + 1),
    );
  }
  const invalid = await fetch(url + "/audio", {
    headers: { Range: "bytes=9000-" },
  });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */" + bytes.length);
});

test("long archives split before a RIFF size overflows", () => {
  const slices = [maxWaveFrames - 3, 3, 1].map((frames, i) => ({
    file: String(i),
    firstFrame: 0,
    frames,
  }));
  const volumes = waveVolumes(slices);
  assert.deepEqual(
    volumes.map((v) => v.frames),
    [maxWaveFrames, 1],
  );
  assert.deepEqual(volumes[0].slices, slices.slice(0, 2));
});
