import { nameOf } from "../../apps/web/lib";
import { chatLimits, type ChatReference } from "../chat/types";
import type { TranscriptClient } from "./client";
import {
  limitOriginal,
  originalExcerpts,
  type OriginalExcerpt,
} from "./original-quotation";

/** DOM anchors live only in the reader. Chat persists the immutable reference. */
export interface CaptionQuotation {
  reference: ChatReference;
  ranges: Range[];
  selection?: Range;
  trigger: HTMLElement;
  viewport: HTMLElement;
  host: HTMLElement;
  keyboard: boolean;
}

export function captureQuotation(
  client: TranscriptClient,
  raw: boolean,
  viewport: HTMLElement,
  host: HTMLElement,
  article: HTMLElement,
  range: Range | undefined,
  keyboard: boolean,
): CaptionQuotation | null {
  const trigger = article.querySelector<HTMLElement>(".utterance-text");
  if (!trigger) return null;
  const ids = new Set<string>(),
    speakers = new Set<string>();
  const pieces: string[] = [],
    ranges: Range[] = [];
  const original: OriginalExcerpt[] = [];
  let start = Infinity,
    end = 0,
    length = 0;
  const articles = range
    ? viewport.querySelectorAll<HTMLElement>("[data-segment]")
    : [article];
  for (const item of articles) {
    if (range && !range.intersectsNode(item)) continue;
    const id = item.dataset.segment!;
    const sources = (!raw && client.reading.turn(id)?.ids) || [id];
    if (ids.size && ids.size + sources.length > chatLimits.sources) break;
    const parts: string[] = [];
    for (const span of item.querySelectorAll(".spoken, .translation")) {
      if (range && !range.intersectsNode(span)) continue;
      const clipped = document.createRange();
      clipped.selectNodeContents(span);
      if (range) {
        if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0)
          clipped.setStart(range.startContainer, range.startOffset);
        if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0)
          clipped.setEnd(range.endContainer, range.endOffset);
      }
      const part = clipped.toString().trim();
      if (part) {
        parts.push(part);
        ranges.push(clipped);
      }
    }
    if (!parts.length) continue;
    const sourceRows = [];
    for (const source of sources.slice(0, chatLimits.sources)) {
      const row = client.rows.get(source);
      if (!row) continue;
      sourceRows.push(row);
      ids.add(source);
      start = Math.min(start, row.start);
      end = Math.max(end, row.end);
      speakers.add(nameOf(row, client.speakerNames));
    }
    original.push(...originalExcerpts(sourceRows, parts));
    const part = parts.join("\n");
    pieces.push(part);
    length += part.length + 1;
    if (length >= chatLimits.quote) break;
  }
  if (!ids.size || !pieces.length) return null;
  const full = pieces.join("\n");
  return {
    reference: {
      ids: [...ids],
      original: limitOriginal(original, chatLimits.quote),
      start,
      end: Math.max(start, end),
      speaker: [...speakers].join(", ").slice(0, 256),
      text:
        full.length > chatLimits.quote
          ? full.slice(0, chatLimits.quote - 1) + "…"
          : full,
    },
    ranges,
    selection: range?.cloneRange(),
    trigger,
    viewport,
    host,
    keyboard,
  };
}

export function releaseQuotation(quote: CaptionQuotation) {
  const selection = window.getSelection();
  if (!quote.selection || !selection?.rangeCount || selection.isCollapsed)
    return;
  const range = selection.getRangeAt(0);
  if (
    range.startContainer.getRootNode() !==
    quote.selection.startContainer.getRootNode()
  )
    return;
  if (
    range.compareBoundaryPoints(Range.START_TO_START, quote.selection) === 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, quote.selection) === 0
  )
    selection.removeAllRanges();
}
