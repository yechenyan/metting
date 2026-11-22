import { chronological, mixedSpeakers, type Segment } from "./types.ts";

export interface SpeakerAssignment {
  id: string;
  start: number;
  speaker: string;
  name: string;
  following: boolean;
}

export function canNameSpeaker(row: Segment, speaker: string) {
  if (speaker === "unknown")
    return row.speaker === speaker && !mixedSpeakers(row);
  return (
    row.speaker === speaker ||
    !!row.spans?.some((span) => span.speaker === speaker)
  );
}

function dividedUtterance(row: Segment) {
  const stream = row.streaming;
  return (
    mixedSpeakers(row) ||
    (row.stage === "final" &&
      stream &&
      (stream.start !== row.start || stream.end !== row.end))
  );
}

export function selectedVoice(row: Segment, speaker: string) {
  // Diarization may finish while the user is entering a name.
  return speaker === "unknown" && !dividedUtterance(row)
    ? row.speaker
    : speaker;
}

/** A recording's manual labels and the points where a voice starts using a name. */
export class SpeakerNames {
  private byVoice = new Map<string, Map<string, SpeakerAssignment>>();
  private following = new Map<string, SpeakerAssignment[]>();

  constructor(
    readonly legacy: Record<string, string> = Object.create(null),
    assignments: SpeakerAssignment[] = [],
  ) {
    this.apply(assignments);
  }

  apply(assignments: SpeakerAssignment[]) {
    const touched = new Set<string>();
    for (const entry of assignments) {
      let labels = this.byVoice.get(entry.speaker);
      if (!labels) {
        labels = new Map();
        this.byVoice.set(entry.speaker, labels);
      }
      labels.set(entry.id, entry);
      if (entry.speaker !== "unknown") {
        this.byVoice.get("unknown")?.delete(entry.id);
        touched.add(entry.speaker);
      }
    }
    for (const speaker of touched) {
      const labels = [...this.byVoice.get(speaker)!.values()];
      this.following.set(
        speaker,
        labels.filter((item) => item.following).sort(chronological),
      );
    }
  }

  snapshot() {
    return Array.from(this.byVoice.values()).flatMap((labels) => [
      ...labels.values(),
    ]);
  }

  assignment(row: Segment, speaker = row.speaker) {
    const own = this.byVoice.get(speaker)?.get(row.id);
    if (own && (speaker !== "unknown" || !mixedSpeakers(row))) return own;
    // A local name entered before diarization stays on the selected utterance.
    const local = this.byVoice.get("unknown")?.get(row.id);
    if (local && speaker === row.speaker && !mixedSpeakers(row)) return local;
  }

  /** Resolve a pending label only when diarization identifies one voice. */
  confirm(row: Segment): SpeakerAssignment | undefined {
    const pending = this.byVoice.get("unknown")?.get(row.id);
    if (!pending?.following) return;
    if (dividedUtterance(row)) return { ...pending, following: false };
    if (row.speaker !== "unknown")
      return { ...pending, speaker: row.speaker, start: row.start };
  }

  name(row: Segment, speaker = row.speaker): string | undefined {
    const own = this.assignment(row, speaker);
    if (own) return own.name;
    const range = this.following
      .get(speaker)
      ?.findLast((entry) => chronological(entry, row) <= 0);
    return range?.name ?? this.legacy[speaker];
  }
}

export function speakerAssignments(
  rows: ReadonlyMap<string, Segment>,
  input: {
    ids?: unknown;
    speaker?: unknown;
    name?: unknown;
    following?: unknown;
  },
): SpeakerAssignment[] {
  const { ids, speaker, following } = input;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    typeof following !== "boolean" ||
    typeof speaker !== "string" ||
    !/^(?:[Sp][1-9]\d*|unknown)$/.test(speaker) ||
    !name ||
    name.length > 64
  )
    throw new Error(
      "A recording passage, speaker, name and matching scope are required",
    );
  if (speaker === "unknown" && ids.length !== 1)
    throw new Error("Choose one passage for an unconfirmed voice");
  return [...new Set(ids)].map((id) => {
    const row = rows.get(id);
    if (!row) throw new Error("The selected passage is no longer available");
    const voice = selectedVoice(row, speaker);
    if (!canNameSpeaker(row, voice))
      throw new Error("The selected passage no longer has that speaker");
    return { id: row.id, start: row.start, speaker: voice, name, following };
  });
}
