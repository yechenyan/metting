import type { Language, Source, SpeakerSpan } from "../speech/types.ts";
import type { RunState, Notice } from "../meetings/types.ts";
import type { Usage } from "../agent-runtime/types.ts";
import type { Draft, Translated } from "./translation.ts";
import type { SpeakerAssignment } from "./speaker-names.ts";
export interface Segment extends Translated, Draft {
  id: string;
  start: number;
  end: number;
  raw: string;
  stage: "partial" | "stream" | "final" | "interrupted";
  language: Language;
  captureSource?: Source | "both";
  speaker: string;
  spans?: SpeakerSpan[];
  edited?: string;
  revision: number;
  reviewed?: boolean;
  streamId?: string;
  streaming?: {
    id: string;
    start: number;
    end: number;
    text: string;
    lastPartial?: string;
  };
  refinement?: "recognized" | "fallback";
}
export interface ReadingTurn extends Translated {
  ids: string[];
  text?: string;
}
export function chronological(
  a: Pick<Segment, "start" | "id">,
  b: Pick<Segment, "start" | "id">,
) {
  return a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function mixedSpeakers(row: Segment) {
  return (
    row.spans?.some((s) => s.overlap || s.speaker !== row.speaker) ?? false
  );
}
export interface ReadingPlan {
  sourceIds: string[];
  turns: ReadingTurn[];
}
export interface Snapshot {
  segments: Segment[];
  reading?: ReadingPlan[];
  speakers: Record<string, string>;
  speakerAssignments?: SpeakerAssignment[];
  usage: Usage;
  state: RunState;
  elapsed: number;
  notice: Notice | null;
  aiStatus: string;
  seq: number;
}
export type Change =
  | { kind: "segment"; segment: Segment }
  | { kind: "revision"; segments: Segment[]; plan?: ReadingPlan }
  | { kind: "remove"; id: string }
  | { kind: "speaker"; id: string; name: string }
  | { kind: "speakerAssignment"; assignments: SpeakerAssignment[] }
  | { kind: "state"; state: RunState; elapsed: number; notice: Notice | null }
  | { kind: "usage"; usage: Usage }
  | { kind: "ai"; status: string }
  | { kind: "notice"; notice: Notice | null };
