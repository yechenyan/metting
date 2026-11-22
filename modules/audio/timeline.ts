export const framesPerMs = 16;
export interface TimeRange {
  start: number;
  end: number;
}
export interface AudioManifest {
  coverage: TimeRange[];
  volumeMs: number[];
  version: string;
}
export const emptyAudio: AudioManifest = {
  coverage: [],
  volumeMs: [],
  version: "",
};

export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const result: TimeRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.end <= range.start) continue;
    const previous = result.at(-1);
    if (previous && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end);
    else result.push({ start: range.start, end: range.end });
  }
  return result;
}
