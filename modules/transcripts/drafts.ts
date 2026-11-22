import type { Language } from "../speech/types.ts";
import type { Segment } from "./types.ts";

// The recognizer can revise an earlier word while extending the same utterance.
export function keepsPrefix(text: string, prefix: string, language: Language) {
  if (!text.startsWith(prefix)) return false;
  const rest = text.slice(prefix.length);
  return (
    !rest ||
    /^\s|^[.,!?;:](?:\s|$)/u.test(rest) ||
    (language === "zh" &&
      (/\p{Script=Han}$/u.test(prefix) || /^\p{Script=Han}/u.test(rest)))
  );
}

// Recognition events replace the source text. Only a completed translation replaces a draft.
export function retainDraft(row: Segment, previous?: Segment): Segment {
  if (
    row.draftTranslation?.text.trim() ||
    !previous?.draftTranslation?.text.trim()
  )
    return row;
  if (
    previous.id !== row.id ||
    previous.language !== row.language ||
    (previous.captureSource &&
      row.captureSource &&
      previous.captureSource !== row.captureSource)
  )
    return row;
  return { ...row, draftTranslation: previous.draftTranslation };
}

export function draftScope(row: Segment): "current" | "previous" | "shared" {
  const draft = row.draftTranslation;
  if (!draft || draft.source === row.raw) return "current";
  if (
    row.stage === "partial" &&
    keepsPrefix(row.raw, draft.source, row.language)
  )
    return "current";
  const stream = row.streaming;
  if (
    row.stage === "final" &&
    stream &&
    stream.id === row.id &&
    (stream.start !== row.start || stream.end !== row.end)
  )
    return "shared";
  return "previous";
}
