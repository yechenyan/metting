import type { Segment } from "./types.ts";

export function streamingResult(row: Segment): Segment["streaming"] {
  return (
    row.streaming ??
    (row.stage !== "final" && row.raw
      ? { id: row.id, start: row.start, end: row.end, text: row.raw }
      : undefined)
  );
}

export function retainRecognition(
  row: Segment,
  rows: ReadonlyMap<string, Segment>,
): Segment {
  if (row.streaming || (row.stage !== "stream" && row.stage !== "final"))
    return row;
  const previous = rows.get(row.id);
  if (row.stage === "stream") {
    if (previous?.stage !== "partial" || previous.raw === row.raw) return row;
    return {
      ...row,
      streaming: {
        id: row.id,
        start: row.start,
        end: row.end,
        text: row.raw,
        lastPartial: previous.raw,
      },
    };
  }
  // Older diarization workers used a numbered suffix for children of a Vosk utterance.
  const parent = row.streamId ?? /^([0-9a-f]{32})-\d+$/.exec(row.id)?.[1];
  const source = (parent && rows.get(parent)) || previous;
  const streaming = source && streamingResult(source);
  if (!streaming) return row;
  return {
    ...row,
    streaming,
    refinement: row.refinement ?? previous?.refinement,
  };
}
