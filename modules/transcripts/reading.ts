import {
  mixedSpeakers,
  type ReadingPlan,
  type ReadingTurn,
  type Segment,
} from "./types.ts";
import { translatedText, type TranslationTarget } from "./translation.ts";
import type { SpeakerNames } from "./speaker-names.ts";

export function turnTranslation(
  turn: ReadingTurn,
  rows: ReadonlyMap<string, Segment>,
  target: TranslationTarget,
) {
  const text = translatedText(turn, target);
  if (text) return text;
  const parts = turn.ids.map((id) => translatedText(rows.get(id), target));
  return parts.every((s) => !!s)
    ? parts.join(target === "zh" ? "" : " ")
    : undefined;
}

/** Report the latest completed step for this caption and the selected language. */
export function captionStatus(
  row: Segment,
  target: TranslationTarget,
  aiTranslation: string | undefined,
  turn?: ReadingTurn,
) {
  if (row.stage !== "final") return row.stage;
  const reviewed = row.reviewed ?? Boolean(row.edited || turn);
  if (reviewed) {
    if (!target || target === row.language) return "reviewed";
    if (aiTranslation?.trim()) return "translated";
  }
  return row.refinement === "fallback" ? "fallback" : "sentence";
}

export function turnStart(
  source: Segment,
  turn: ReadingTurn | undefined,
  rows: ReadonlyMap<string, Segment>,
) {
  return turn
    ? Math.min(...turn.ids.map((id) => rows.get(id)?.start ?? source.start))
    : source.start;
}

/** Only non-chronological or merged passages need a stored plan. */
export class ReadingLayout {
  private plans = new Map<string, ReadingPlan>();
  private membership = new Map<string, ReadingPlan>();

  constructor(plans: ReadingPlan[] = []) {
    for (const plan of plans) this.replace(plan);
  }
  snapshot() {
    return [...this.plans.values()];
  }
  forSource(id: string) {
    return this.membership.get(id);
  }
  turn(id: string): ReadingTurn | undefined {
    return this.forSource(id)?.turns.find((turn) => turn.ids.includes(id));
  }
  order(ids: string[]) {
    if (!this.plans.size) return ids;
    const result: string[] = [];
    for (const id of ids) {
      const plan = this.forSource(id);
      if (!plan) result.push(id);
      else if (plan.sourceIds[0] === id)
        for (const turn of plan.turns) result.push(turn.ids[0]);
    }
    return result;
  }
  editable(ids: string[]) {
    return ids.filter(
      (id) =>
        this.forSource(id)?.sourceIds.every((member) => ids.includes(member)) ??
        true,
    );
  }
  remove(id: string) {
    const plan = this.forSource(id);
    if (!plan) return false;
    for (const member of plan.sourceIds) this.membership.delete(member);
    this.plans.delete(plan.sourceIds[0]);
    return true;
  }
  separateSpeakers(rows: ReadonlyMap<string, Segment>, names: SpeakerNames) {
    let changed = false;
    for (const plan of this.snapshot()) {
      let split = false;
      const turns = plan.turns.flatMap((turn) => {
        if (turn.ids.length < 2) return [turn];
        const first = rows.get(turn.ids[0]);
        const name = first && names.name(first);
        const conflict =
          !first ||
          turn.ids.some((id) => {
            const row = rows.get(id);
            return !row || names.name(row) !== name;
          });
        if (!conflict) return [turn];
        split = true;
        return turn.ids.map((id) => ({ ids: [id] }));
      });
      if (split) {
        this.replace({ ...plan, turns });
        changed = true;
      }
    }
    return changed;
  }
  changedSource(old: Segment | undefined, row: Segment) {
    if (!old || !this.membership.has(row.id)) return false;
    if (
      old.raw === row.raw &&
      old.edited === row.edited &&
      old.translation === row.translation &&
      old.translationLanguage === row.translationLanguage &&
      old.speaker === row.speaker &&
      old.language === row.language &&
      old.start === row.start &&
      old.end === row.end &&
      old.stage === row.stage &&
      mixedSpeakers(old) === mixedSpeakers(row)
    )
      return false;
    return this.remove(row.id);
  }
  replace(plan: ReadingPlan) {
    if (this.editable(plan.sourceIds).length !== plan.sourceIds.length)
      return false;
    let changed = false;
    for (const id of plan.sourceIds) if (this.remove(id)) changed = true;
    const ids = [...plan.sourceIds],
      turns = [...plan.turns];
    // Leave unchanged edge turns free to join the next revision window.
    while (
      turns.length &&
      turns[0].ids.length === 1 &&
      turns[0].ids[0] === ids[0]
    ) {
      turns.shift();
      ids.shift();
    }
    while (
      turns.length &&
      turns.at(-1)!.ids.length === 1 &&
      turns.at(-1)!.ids[0] === ids.at(-1)
    ) {
      turns.pop();
      ids.pop();
    }
    if (!turns.length) return changed;
    const block = { sourceIds: ids, turns };
    this.plans.set(ids[0], block);
    for (const id of ids) this.membership.set(id, block);
    return true;
  }
}
