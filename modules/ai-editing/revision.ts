import {
  chronological,
  mixedSpeakers,
  type Segment,
} from "../transcripts/types.ts";
import type { Journal } from "../transcripts/journal.ts";
import { type makeContext, readRevision } from "./context.ts";
import { validateArrangement } from "./arrangement.ts";

type Context = NonNullable<ReturnType<typeof makeContext>>;
export function applyRevision(
  journal: Journal,
  ctx: Context,
  target: Segment,
  response: string | ReturnType<typeof readRevision>,
  needs: (s: Segment) => boolean,
) {
  const current = journal.rows.get(target.id);
  if (
    !current ||
    current.stage !== "final" ||
    current.raw !== target.raw ||
    current.language !== target.language ||
    current.revision !== target.revision ||
    current.speaker !== target.speaker ||
    current.start !== target.start ||
    current.end !== target.end ||
    mixedSpeakers(current) !== mixedSpeakers(target)
  )
    return;
  const reply =
    typeof response === "string" ? readRevision(response) : response;
  const segments: Segment[] = [];
  const accepted = new Set<string>();
  for (const entry of ctx.editable) {
    const row = journal.rows.get(entry.id);
    if (
      !row ||
      row.stage !== "final" ||
      row.raw !== entry.original ||
      row.language !== entry.language ||
      row.revision !== entry.revision ||
      row.speaker !== entry.speakerId ||
      row.start !== entry.startMs ||
      row.end !== entry.endMs ||
      mixedSpeakers(row) !== entry.mixed
    )
      continue;
    // A read-only portion of an earlier merged passage keeps its existing wording.
    if (!ctx.arrangeableIds.includes(row.id) && !needs(row)) continue;
    const matches = reply.updates.filter(
      (u) => u.id === row.id && u.revision === row.revision,
    );
    const update = matches[0];
    const translation =
      typeof update?.translation === "string" ? update.translation.trim() : "";
    const language =
      ctx.translationTarget !== row.language ? ctx.translationTarget : null;
    if (matches.length !== 1 || (language && !translation)) {
      if (needs(row) || row.id === target.id)
        throw new Error("Missing requested transcript revision");
      continue;
    }
    accepted.add(row.id);
    segments.push({
      ...row,
      edited: update.text.trim(),
      revision: row.revision + 1,
      ...(language
        ? { translation, translationLanguage: language }
        : update.text.trim() === row.edited
          ? {}
          : { translation: undefined, translationLanguage: undefined }),
      reviewed: true,
    });
  }
  const candidates = ctx.arrangeableIds.map((id) => journal.rows.get(id)!);
  let plan;
  if (
    Array.isArray(reply.turns) &&
    candidates.length &&
    ctx.arrangeableIds.every((id) => accepted.has(id)) &&
    journal.reading.editable(ctx.arrangeableIds).length === candidates.length
  ) {
    const inRange = [...journal.rows.values()]
      .filter(
        (s) =>
          s.stage === "final" &&
          s.start >= candidates[0].start &&
          s.start <= candidates.at(-1)!.start,
      )
      .sort(chronological);
    const first = inRange.findIndex((s) => s.id === candidates[0].id);
    if (
      first >= 0 &&
      candidates.every((s, i) => inRange[first + i]?.id === s.id)
    )
      plan = validateArrangement(
        reply.turns,
        candidates,
        ctx.translationTarget,
      );
  }
  if (segments.length) journal.emit({ kind: "revision", segments, plan });
  return accepted;
}
