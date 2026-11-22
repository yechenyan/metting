import { useEffect, useRef, type RefObject } from "react";
import { captureQuotation, type CaptionQuotation } from "./quotation";
import type { TranscriptClient } from "./client";

function inside(node: Node | null, selector: string) {
  return (
    node instanceof Element ? node : node?.parentElement
  )?.closest<HTMLElement>(selector);
}
export function useQuotation(
  scroll: RefObject<HTMLDivElement | null>,
  portal: RefObject<HTMLDivElement | null>,
  client: TranscriptClient,
  raw: boolean,
  ask: (quotation: CaptionQuotation) => void,
) {
  const interacting = useRef(false);
  useEffect(() => {
    const root = scroll.current;
    const host = portal.current;
    if (!root || !host) return;
    let press: ReturnType<typeof setTimeout>;
    let origin:
      | {
          x: number;
          y: number;
          article: HTMLElement;
          pointer: number;
          dragged: boolean;
        }
      | undefined;
    let handled = false;
    function selected() {
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (
        !root!.contains(range.startContainer) &&
        !root!.contains(range.endContainer)
      )
        return;
      return range;
    }
    function quote(article: HTMLElement, range?: Range, keyboard = false) {
      const captured = captureQuotation(
        client,
        raw,
        root!,
        host!,
        article,
        range,
        keyboard,
      );
      if (!captured) return;
      if (!range && selected()) window.getSelection()?.removeAllRanges();
      clearTimeout(press);
      handled = true;
      ask(captured);
    }
    function down(event: PointerEvent) {
      clearTimeout(press);
      origin = undefined;
      interacting.current = false;
      handled = false;
      const target = inside(event.target as Node, ".utterance-text");
      const article = target?.closest<HTMLElement>("[data-segment]");
      if (event.button !== 0 || !event.isPrimary || !article) return;
      interacting.current = true;
      origin = {
        x: event.clientX,
        y: event.clientY,
        article,
        pointer: event.pointerId,
        dragged: false,
      };
      press = setTimeout(() => {
        if (root!.contains(article)) quote(article);
      }, 470);
    }
    function move(event: PointerEvent) {
      if (
        origin &&
        (Math.abs(event.clientX - origin.x) > 3 ||
          Math.abs(event.clientY - origin.y) > 3)
      ) {
        origin.dragged = true;
        clearTimeout(press);
      }
    }
    function cancel() {
      clearTimeout(press);
      origin = undefined;
      interacting.current = false;
    }
    function up(event: PointerEvent) {
      const current = origin;
      cancel();
      if (handled || current?.pointer !== event.pointerId) return;
      const range = (current.dragged || event.shiftKey) && selected();
      if (range) quote(current.article, range);
    }
    function activate(event: MouseEvent) {
      const element = event.target as Node;
      const article = inside(element, "[data-segment]");
      if (!article) return;
      if (!inside(element, ".utterance-text") || (handled && event.detail > 0))
        return;
      const range = event.detail > 1 || event.shiftKey ? selected() : undefined;
      quote(
        article,
        range?.intersectsNode(article) ? range : undefined,
        event.detail === 0,
      );
    }
    function menu(event: MouseEvent) {
      const article = inside(
        event.target as Node,
        ".utterance-text",
      )?.closest<HTMLElement>("[data-segment]");
      if (!article) return;
      event.preventDefault();
      if (!handled) quote(article, selected());
    }
    function key(event: KeyboardEvent) {
      const range = selected();
      const article = range && inside(range.startContainer, "[data-segment]");
      if (event.key === "Shift" && article) quote(article, range, true);
    }
    const events = new AbortController(),
      options = { signal: events.signal };
    root.addEventListener("pointerdown", down, options);
    window.addEventListener("pointermove", move, { ...options, passive: true });
    window.addEventListener("pointerup", up, options);
    window.addEventListener("pointercancel", cancel, options);
    window.addEventListener("blur", cancel, options);
    root.addEventListener("scroll", () => clearTimeout(press), {
      ...options,
      passive: true,
    });
    root.addEventListener("click", activate, options);
    root.addEventListener("contextmenu", menu, options);
    root.addEventListener("keyup", key, options);
    return () => {
      events.abort();
      cancel();
    };
  }, [scroll, portal, client, raw, ask]);
  return interacting;
}
