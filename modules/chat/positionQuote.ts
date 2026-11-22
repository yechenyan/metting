import type { CaptionQuotation } from "../transcripts/quotation";

function visibleLine(quote: CaptionQuotation, top: number, bottom: number) {
  let hasText = false;
  for (const range of quote.ranges) {
    if (range.collapsed || !range.commonAncestorContainer.isConnected) continue;
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      hasText = true;
      if (rect.bottom > top && rect.top < bottom) return rect;
    }
  }
  // Live recognition can replace the text node while the quoted wording stays frozen.
  const rect = quote.trigger.getBoundingClientRect();
  return !hasText && rect.bottom > top && rect.top < bottom ? rect : null;
}

export function trackQuote(
  quote: CaptionQuotation,
  panel: HTMLElement,
  hasDraft: () => boolean,
  dismiss: () => void,
) {
  const { viewport, trigger, host } = quote;
  const visual = window.visualViewport;
  let frame = 0;
  let lastMid: number | undefined;
  function place() {
    frame = 0;
    const reader = viewport.getBoundingClientRect();
    const top = visual?.offsetTop ?? 0,
      left = visual?.offsetLeft ?? 0;
    const firstY = Math.max(top, reader.top);
    const lastY = Math.min(
      top + (visual?.height ?? window.innerHeight),
      reader.bottom,
    );
    const line =
      trigger.isConnected && lastY > firstY
        ? visibleLine(quote, firstY, lastY)
        : null;
    if (!line && !hasDraft()) {
      dismiss();
      return;
    }
    const minX = Math.max(left, reader.left) + 5;
    const edge =
      Math.min(left + (visual?.width ?? window.innerWidth), reader.right) - 5;
    panel.style.maxWidth = Math.max(0, edge - minX) + "px";
    const width = panel.offsetWidth;
    if (line) lastMid = line.left + line.width / 2;
    const mid = lastMid ?? (minX + edge) / 2;
    const x = Math.max(minX, Math.min(mid - width / 2, edge - width));
    const y = Math.max(firstY, line?.top ?? firstY) - host.offsetHeight - 7;
    const hostRect = host.getBoundingClientRect();
    // Reserve space above the reader at the top edge or when a live edit removes a draft's anchor.
    const docked =
      !line || y - panel.offsetHeight < Math.max(top, hostRect.top) + 4;
    panel.dataset.placement = docked ? "docked" : "above";
    panel.style.left = (docked ? x - hostRect.left : x) + "px";
    panel.style.top = (docked ? 0 : y) + "px";
    panel.style.setProperty(
      "--quote-tip",
      Math.max(10, Math.min(mid - x, width - 10)) + "px",
    );
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };
  const events = new AbortController();
  const options = { passive: true, signal: events.signal };
  viewport.addEventListener("scroll", schedule, options);
  window.addEventListener("resize", schedule, options);
  visual?.addEventListener("scroll", schedule, options);
  visual?.addEventListener("resize", schedule, options);
  const sizes = new ResizeObserver(schedule);
  for (const element of [viewport, trigger, panel]) sizes.observe(element);
  const moves = new MutationObserver(schedule);
  const row = trigger.closest(".virtual-row");
  if (row) {
    moves.observe(row, {
      attributes: true,
      attributeFilter: ["style"],
      childList: true,
      characterData: true,
      subtree: true,
    });
    if (row.parentElement)
      moves.observe(row.parentElement, { childList: true });
  }
  place();
  return () => {
    events.abort();
    sizes.disconnect();
    moves.disconnect();
    cancelAnimationFrame(frame);
  };
}
