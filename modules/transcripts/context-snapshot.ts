import type { Journal } from "./journal.ts";
import { chronological } from "./types.ts";

export type TranscriptSource = Pick<
  Journal,
  "rows" | "names" | "rawCursor" | "rawChangedAt"
> &
  Partial<Pick<Journal, "flush">>;

export interface RawPassage {
  id: string;
  start: number;
  end: number;
  speaker: string;
  raw: string;
  changedAt: number;
}

interface TranscriptSnapshot {
  cursor: number;
  rows: RawPassage[];
  byId: Map<string, RawPassage>;
}

const snapshots = new WeakMap<TranscriptSource, TranscriptSnapshot>();

// Capture a stable view at submission. Sorting is shared across questions and
// conversations until a change to the original words, time or speaker.
export function snapshotTranscript(
  source: TranscriptSource,
): TranscriptSnapshot {
  const cached = snapshots.get(source);
  if (cached?.cursor === source.rawCursor) return cached;
  const rows = Array.from(source.rows.values(), (row) => ({
    id: row.id,
    start: row.start,
    end: row.end,
    raw: row.raw,
    speaker:
      source.names[row.speaker] ||
      row.speaker.replace(/^[Sp](\d+)$/, "Speaker $1"),
    changedAt: source.rawChangedAt(row),
  })).sort(chronological);
  const snapshot = {
    cursor: source.rawCursor,
    rows,
    byId: new Map(rows.map((row) => [row.id, row])),
  };
  snapshots.set(source, snapshot);
  return snapshot;
}
