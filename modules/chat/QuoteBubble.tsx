import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, X } from "lucide-react";
import { t } from "../../apps/web/lib";
import type { CaptionQuotation } from "../transcripts/quotation";
import { trackQuote } from "./positionQuote";
import { chatLimits } from "./types";

export function QuoteBubble({
  quotation,
  ready,
  busy,
  error,
  dismiss,
  login,
  submit,
}: {
  quotation: CaptionQuotation;
  ready: boolean;
  busy: boolean;
  error: string;
  dismiss: () => void;
  login: () => void;
  submit: (question: string) => Promise<void>;
}) {
  const [question, setQuestion] = useState("");
  const composing = useRef(false);
  const panel = useRef<HTMLFormElement>(null),
    input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = panel.current!;
    const highlight =
      typeof Highlight === "function" && CSS.highlights
        ? new Highlight(...quotation.ranges)
        : null;
    if (highlight) CSS.highlights.set("meeting-quotation", highlight);
    const stop = trackQuote(
      quotation,
      el,
      () => !!input.current?.value.trim(),
      dismiss,
    );
    if (quotation.keyboard) input.current?.focus({ preventScroll: true });
    const events = new AbortController();
    function outside(event: Event) {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        el.contains(target) ||
        target.closest("dialog:modal")
      )
        return;
      // Finish a new selection before replacing the open bubble.
      if (
        quotation.viewport.contains(target) &&
        target.closest(".utterance-text")
      )
        return;
      dismiss();
    }
    document.addEventListener("pointerdown", outside, {
      capture: true,
      signal: events.signal,
    });
    document.addEventListener("focusin", outside, { signal: events.signal });
    document.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key !== "Escape" ||
          event.isComposing ||
          document.querySelector("dialog:modal")
        )
          return;
        event.preventDefault();
        if (el.contains(document.activeElement))
          quotation.trigger.focus({ preventScroll: true });
        dismiss();
      },
      { signal: events.signal },
    );
    return () => {
      events.abort();
      stop();
      if (highlight && CSS.highlights.get("meeting-quotation") === highlight)
        CSS.highlights.delete("meeting-quotation");
    };
  }, [quotation, dismiss]);

  const enabled = ready && !busy;
  return createPortal(
    <form
      ref={panel}
      className="quote-bubble"
      role="dialog"
      aria-label={t.askPassage}
      aria-modal="false"
      onSubmit={(event) => {
        event.preventDefault();
        if (enabled && !composing.current && question.trim())
          void submit(question.trim());
      }}
    >
      <div className="quote-input-line">
        <input
          ref={input}
          type="text"
          aria-label={t.yourQuestion}
          placeholder={t.quotePlaceholder}
          maxLength={chatLimits.question}
          autoComplete="off"
          enterKeyHint="send"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            composing.current =
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229;
          }}
          onKeyUp={() => {
            composing.current = false;
          }}
          onBlur={() => {
            composing.current = false;
          }}
        />
        <button
          type="submit"
          aria-label={t.sendQuestion}
          title={t.sendQuestion}
          disabled={!enabled || !question.trim()}
        >
          <ArrowUp size={15} />
        </button>
        <button
          type="button"
          aria-label={t.close}
          title={t.close}
          onClick={() => {
            quotation.trigger.focus({ preventScroll: true });
            dismiss();
          }}
        >
          <X size={13} />
        </button>
      </div>
      <div className="quote-presets">
        {[t.explainSimply, t.answerQuickly].map((prompt) => (
          <button
            type="button"
            key={prompt}
            disabled={!enabled}
            onClick={() => void submit(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
      {!ready ? (
        <button className="quote-login" type="button" onClick={login}>
          {t.connect}
        </button>
      ) : (
        busy && (
          <span className="quote-note" role="status">
            {t.chatBusy}
          </span>
        )
      )}
      {error && (
        <span className="quote-note" role="alert">
          {error}
        </span>
      )}
    </form>,
    quotation.host,
  );
}
