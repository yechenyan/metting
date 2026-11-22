import {
  mixedSpeakers,
  type ReadingPlan,
  type ReadingTurn,
  type Segment,
} from "../transcripts/types.ts";
import type { TranslationTarget } from "../transcripts/translation.ts";

export function validateArrangement(
  proposed: unknown,
  sources: Segment[],
  translationTarget: TranslationTarget,
): ReadingPlan | undefined {
  if (
    !Array.isArray(proposed) ||
    !sources.length ||
    !proposed.length ||
    proposed.length > sources.length
  )
    return;
  const byId = new Map(sources.map((s) => [s.id, s]));
  const seen = new Set<string>(),
    turns: ReadingTurn[] = [];
  for (const entry of proposed) {
    if (
      !entry ||
      !Array.isArray(entry.ids) ||
      !entry.ids.length ||
      entry.ids.length > sources.length
    )
      return;
    const members: Segment[] = [];
    for (const id of entry.ids) {
      const source = byId.get(id);
      if (!source || seen.has(id)) return;
      seen.add(id);
      members.push(source);
    }
    const turn: ReadingTurn = { ids: members.map((s) => s.id) };
    if (members.length > 1) {
      const first = members[0];
      if (
        first.speaker === "unknown" ||
        members.some(
          (s) =>
            s.speaker !== first.speaker ||
            s.language !== first.language ||
            mixedSpeakers(s),
        )
      )
        return;
      if (typeof entry.text !== "string" || !entry.text.trim()) return;
      turn.text = entry.text.trim();
      if (translationTarget && first.language !== translationTarget) {
        if (typeof entry.translation !== "string" || !entry.translation.trim())
          return;
        turn.translation = entry.translation.trim();
        turn.translationLanguage = translationTarget;
      }
    }
    turns.push(turn);
  }
  if (seen.size !== sources.length) return;
  return { sourceIds: sources.map((s) => s.id), turns };
}
