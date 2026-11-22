import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  framesPerMs,
  mergeRanges,
  type AudioManifest,
  type TimeRange,
} from "./timeline.ts";

export const headerSize = 44;
export const maxWaveFrames = Math.floor((0xffffffff - 36) / 2);
export interface AudioPart {
  file: string;
  start: number;
  frames: number;
}
export interface AudioSlice {
  file: string;
  firstFrame: number;
  frames: number;
}
export function readAudioParts(directory: string): AudioPart[] {
  const path = join(directory, "audio");
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parts: AudioPart[] = [];
  for (const entry of entries) {
    const match = /^(\d{12,16})-[a-f0-9]{32}\.wav$/.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    const file = join(path, entry.name);
    // The payload length also recovers packets flushed before an interrupted header update.
    const frames = Math.floor((statSync(file).size - headerSize) / 2);
    if (frames > 0 && frames <= maxWaveFrames)
      parts.push({ file, start: Number(match[1]), frames });
  }
  return parts.sort(
    (a, b) => a.start - b.start || a.file.localeCompare(b.file),
  );
}

export function audioSlices(
  parts: readonly AudioPart[],
  ranges?: readonly TimeRange[],
): AudioSlice[] {
  if (!ranges)
    return parts.map((p) => ({
      file: p.file,
      firstFrame: 0,
      frames: p.frames,
    }));
  const slices: AudioSlice[] = [];
  const times = mergeRanges(ranges);
  for (const part of parts) {
    for (const { start, end } of times) {
      const firstFrame = Math.max(
        0,
        Math.round((start - part.start) * framesPerMs),
      );
      const lastFrame = Math.min(
        part.frames,
        Math.round((end - part.start) * framesPerMs),
      );
      if (lastFrame > firstFrame)
        slices.push({
          file: part.file,
          firstFrame,
          frames: lastFrame - firstFrame,
        });
    }
  }
  return slices;
}

// A RIFF/WAVE data chunk has a 32-bit size. Very long recordings continue in the next volume.
export function waveVolumes(slices: readonly AudioSlice[]) {
  const volumes: { slices: AudioSlice[]; frames: number }[] = [];
  for (const slice of slices) {
    let volume = volumes.at(-1);
    if (!volume || volume.frames + slice.frames > maxWaveFrames) {
      volume = { slices: [], frames: 0 };
      volumes.push(volume);
    }
    volume.slices.push(slice);
    volume.frames += slice.frames;
  }
  return volumes;
}

export function audioManifest(parts: readonly AudioPart[]): AudioManifest {
  const last = parts.at(-1);
  return {
    coverage: mergeRanges(
      parts.map((p) => ({
        start: p.start,
        end: p.start + p.frames / framesPerMs,
      })),
    ),
    volumeMs: waveVolumes(audioSlices(parts)).map(
      (v) => v.frames / framesPerMs,
    ),
    version: last
      ? [parts.length, basename(last.file, ".wav"), last.frames].join("-")
      : "",
  };
}
