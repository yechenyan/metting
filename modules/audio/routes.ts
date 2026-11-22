import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileDisposition, json, type Route } from "../../shared/http.ts";
import type { Segment } from "../transcripts/types.ts";
import {
  audioManifest,
  audioSlices,
  headerSize,
  waveVolumes,
  type AudioPart,
  type AudioSlice,
} from "./archive.ts";

function waveHeader(frames: number) {
  const bytes = frames * 2,
    header = Buffer.alloc(headerSize);
  header.write("RIFF", 0);
  header.writeUInt32LE(bytes + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return header;
}

export function byteRange(range: string | undefined, size: number) {
  if (range === undefined) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
  if (!match || !(match[1] || match[2])) return null;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end =
    match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return Number.isSafeInteger(start) && start <= end ? { start, end } : null;
}

async function* waveBytes(
  slices: AudioSlice[],
  frames: number,
  start: number,
  end: number,
) {
  if (start < headerSize) yield waveHeader(frames).subarray(start, end + 1);
  let position = headerSize;
  for (const slice of slices) {
    if (position > end) break;
    const next = position + slice.frames * 2;
    if (start < next) {
      const offset = headerSize + slice.firstFrame * 2;
      const file = await open(
        slice.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        yield* file.createReadStream({
          start: offset + Math.max(0, start - position),
          end: offset + Math.min(end + 1, next) - position - 1,
        });
      } finally {
        await file.close();
      }
    }
    position = next;
  }
}

export async function audioRoute(
  { req, res, action }: Route,
  parts: AudioPart[],
  rows: ReadonlyMap<string, Segment>,
  stem = "recording",
) {
  if (action === "audio-info") return json(res, audioManifest(parts));
  const params = new URL(req.url!, "http://localhost").searchParams;
  const sources: Segment[] = [];
  for (const id of new Set(params.getAll("sentence"))) {
    const source = rows.get(id);
    if (!source) return json(res, { error: "Unknown sentence" }, 404);
    sources.push(source);
  }
  const slices = audioSlices(parts, sources.length ? sources : undefined);
  const volume = waveVolumes(slices)[Number(params.get("volume") || 0)];
  if (!volume)
    return json(res, { error: "No saved audio for this selection" }, 404);
  const size = headerSize + volume.frames * 2,
    range = byteRange(req.headers.range, size);
  if (!range) {
    res.writeHead(416, {
      "Content-Range": "bytes */" + size,
      "Accept-Ranges": "bytes",
    });
    return res.end();
  }
  const { start, end } = range;
  res.writeHead(req.headers.range ? 206 : 200, {
    "Content-Type": "audio/wav",
    "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": fileDisposition(
      "inline",
      stem +
        (params.get("volume")
          ? " - " + (Number(params.get("volume")) + 1)
          : "") +
        ".wav",
    ),
    ...(req.headers.range && {
      "Content-Range": `bytes ${start}-${end}/${size}`,
    }),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  try {
    await pipeline(
      Readable.from(waveBytes(volume.slices, volume.frames, start, end)),
      res,
    );
  } catch {
    res.destroy();
  }
}
