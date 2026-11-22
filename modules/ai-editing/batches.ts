import type { Meeting } from "../meetings/types.ts";
import type { Journal } from "../transcripts/journal.ts";
import { chronological, type Segment } from "../transcripts/types.ts";
import {
  translatedText,
  translationTarget,
} from "../transcripts/translation.ts";
import { makeContext } from "./context.ts";

export type EditingJob = {
  meeting: Meeting;
  journal: Journal;
  history: Set<string>;
  boundaries: string[][];
};

export function nextBatch(job: EditingJob, reserved: Set<string>) {
  const { meeting, journal } = job;
  const lang = translationTarget(meeting.settings);
  const rows = [...journal.rows.values()]
    .filter((r) => r.stage === "final")
    .sort(chronological);
  const needs = (s: Segment) =>
    !s.reviewed ||
    job.history.has(s.id) ||
    (!!lang && s.language !== lang && !translatedText(s, lang));
  let start = -1;
  let batch: Segment[] = [];
  let reconciling = false;
  for (let i = 0; i < rows.length && batch.length < 3; i++) {
    const prior = journal.reading.forSource(rows[i].id)?.sourceIds;
    if (!prior && (reserved.has(rows[i].id) || !needs(rows[i]))) {
      if (batch.length) break;
      continue;
    }
    // Keep earlier merged turns together when changing target or reorganizing.
    const length =
      prior && prior.every((id, j) => rows[i + j]?.id === id)
        ? prior.length
        : 1;
    const group = rows.slice(i, i + length);
    const available =
      group.some(needs) && group.every((row) => !reserved.has(row.id));
    if (!available && batch.length) break;
    if (available) {
      if (batch.length + length > 3) break;
      if (!batch.length) start = i;
      batch.push(...group);
    }
    i += length - 1;
  }
  if (!batch.length) {
    for (const boundary of [...job.boundaries]) {
      if (boundary.some((id) => reserved.has(id))) continue;
      job.boundaries.splice(job.boundaries.indexOf(boundary), 1);
      start = rows.findIndex((r) => r.id === boundary[0]);
      const range = rows.slice(start, start + boundary.length);
      if (
        start >= 0 &&
        boundary.every((id, i) => range[i]?.id === id) &&
        journal.reading.editable(boundary).length === boundary.length
      ) {
        batch = range;
        reconciling = true;
        break;
      }
    }
  }
  if (!batch.length) return;
  const target = batch.at(-1)!;
  const ids = new Set(batch.map((r) => r.id));
  const end = start + batch.length;
  const context = makeContext(
    rows.slice(Math.max(0, end - 12), end),
    target.id,
    journal.names,
    lang,
    journal.reading,
    ids,
    reconciling,
  )!;
  return { ids, context, target, needs, reconciling };
}

export type EditingBatch = NonNullable<ReturnType<typeof nextBatch>>;

export function requestBoundary(
  job: EditingJob,
  batch: EditingBatch,
  proposed: unknown,
) {
  if (
    batch.reconciling ||
    !Array.isArray(proposed) ||
    proposed.length < 2 ||
    proposed.length > 3
  )
    return;
  const window = [...batch.context.reference, ...batch.context.editable].map(
    (r) => r.id,
  );
  const at = window.indexOf(proposed[0]);
  if (
    at < 0 ||
    !proposed.every((id, i) => id === window[at + i]) ||
    batch.ids.has(proposed[0]) ||
    !batch.ids.has(proposed.at(-1))
  )
    return;
  if (
    !job.boundaries.some(
      (ids) =>
        ids.length === proposed.length &&
        ids.every((id, i) => id === proposed[i]),
    )
  )
    job.boundaries.push(proposed.slice());
}
