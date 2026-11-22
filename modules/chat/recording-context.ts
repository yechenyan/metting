import {
  snapshotTranscript,
  type RawPassage,
  type TranscriptSource,
} from "../transcripts/context-snapshot.ts";
import { originalExcerpts } from "../transcripts/original-quotation.ts";
import { chronological } from "../transcripts/types.ts";
import { chatLimits, type ChatReference } from "./types.ts";

export interface RecordingEvidence {
  quotation?: string;
  transcript?: string;
}

type Passage = Pick<RawPassage, "start" | "end" | "speaker" | "raw">;

function time(ms: number) {
  const whole = Math.round(ms);
  const seconds = Math.floor(whole / 1000);
  const clock = [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return whole % 1000
    ? clock + "." + String(whole % 1000).padStart(3, "0")
    : clock;
}

function escapedLength(text: string) {
  return JSON.stringify(text).length - 2;
}

// Fit the tail of one oversized utterance without splitting a Unicode character.
function clippedLine(prefix: string, raw: string, available: number) {
  const start = prefix + "…";
  let remaining = available - escapedLength(start);
  if (remaining <= 0) return "";
  let offset = raw.length;
  while (offset > 0) {
    const paired =
      offset >= 2 &&
      /[\uDC00-\uDFFF]/u.test(raw[offset - 1]) &&
      /[\uD800-\uDBFF]/u.test(raw[offset - 2]);
    const previous = offset - (paired ? 2 : 1);
    const cost = escapedLength(raw.slice(previous, offset));
    if (cost > remaining) break;
    remaining -= cost;
    offset = previous;
  }
  return offset < raw.length ? start + raw.slice(offset) : "";
}

function latestLines<T extends Passage>(
  rows: readonly T[],
  available: number,
  include: (row: T) => boolean,
) {
  const lines: string[] = [];
  for (let i = rows.length - 1; i >= 0 && available > 0; i--) {
    const row = rows[i];
    if (!include(row) || !row.raw.trim()) continue;
    const prefix = `[${time(row.start)}–${time(row.end)}] ${row.speaker}: `;
    const line = prefix + row.raw;
    const cost = line.length > available ? Infinity : escapedLength(line);
    if (cost > available) {
      if (!lines.length) {
        const clipped = clippedLine(prefix, row.raw, available);
        if (clipped) lines.push(clipped);
      }
      break;
    }
    lines.push(line);
    available -= cost + 2; // A newline occupies two characters in the wire JSON.
  }
  return lines.reverse().join("\n");
}

function selectedPassages(
  snapshot: ReturnType<typeof snapshotTranscript>,
  reference: ChatReference,
) {
  const ids = new Set(reference.ids);
  let sources = reference.ids.flatMap((id) => snapshot.byId.get(id) ?? []);
  // A live recognizer may replace a provisional ID before the question arrives.
  if (sources.length < ids.size) {
    sources = snapshot.rows.filter(
      (row) =>
        ids.has(row.id) ||
        (row.start < reference.end && row.end > reference.start),
    );
  }
  const originals =
    reference.original ?? originalExcerpts(sources, reference.text.split("\n"));
  const covered = new Set<string>();
  const passages = originals
    .map(({ id, text }) => {
      const row = snapshot.byId.get(id);
      if (row) covered.add(id);
      else for (const replacement of sources) covered.add(replacement.id);
      return {
        id,
        raw: text,
        start: row?.start ?? reference.start,
        end: row?.end ?? reference.end,
        speaker: row?.speaker ?? reference.speaker,
      };
    })
    .sort(chronological);
  return { passages, covered };
}

export function prepareRecording(
  source: TranscriptSource,
  reference: ChatReference | null,
  delivered?: number,
) {
  const snapshot = snapshotTranscript(source);
  const selected = reference
    ? selectedPassages(snapshot, reference)
    : undefined;
  const evidence: RecordingEvidence = {};
  if (selected?.passages.length) {
    const available =
      chatLimits.recording -
      JSON.stringify({ recording: { quotation: "" } }).length;
    const quote = latestLines(selected.passages, available, () => true);
    if (quote) evidence.quotation = quote;
  }
  function build(since?: number): RecordingEvidence {
    if (since === snapshot.cursor) return evidence;
    const available =
      chatLimits.recording -
      JSON.stringify({ recording: { ...evidence, transcript: "" } }).length;
    const transcript = latestLines(
      snapshot.rows,
      available,
      (row) =>
        (since === undefined || row.changedAt > since) &&
        !selected?.covered.has(row.id),
    );
    return transcript ? { ...evidence, transcript } : evidence;
  }
  // A missing legacy checkpoint or a restored, shorter journal needs a fresh window.
  const since =
    delivered !== undefined && delivered <= snapshot.cursor
      ? delivered
      : undefined;
  const current = build(since);
  return {
    cursor: snapshot.cursor,
    evidence: current,
    initial: since === undefined ? () => current : () => build(),
  };
}
