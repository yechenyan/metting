import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ChevronDown, Quote, RotateCcw } from "lucide-react";
import { clock, t } from "../../apps/web/lib";
import type { ChatClient } from "./client";
import type { ChatReference, ChatTurn } from "./types";
import { ActivityLog } from "./ActivityLog";

function QuoteCard({ reference }: { reference: ChatReference }) {
  const caption = [clock(reference.start), reference.speaker]
    .filter(Boolean)
    .join(" · ");
  return (
    <details className="chat-quote saved-quote">
      <summary>
        <Quote size={12} />
        <span>{caption}</span>
        <span className="quote-excerpt">{reference.text}</span>
        <ChevronDown size={12} />
      </summary>
      <blockquote>{reference.text}</blockquote>
    </details>
  );
}
const Exchange = memo(function Exchange({
  turn,
  client,
  retry,
  canRetry,
}: {
  turn: ChatTurn;
  client: ChatClient;
  retry: (turn: ChatTurn) => void;
  canRetry: boolean;
}) {
  return (
    <article className="chat-exchange" data-question={turn.id}>
      <div className="chat-question">
        {turn.reference && <QuoteCard reference={turn.reference} />}
        <p>{turn.question}</p>
      </div>
      <div className="answer-byline">
        <span>AI</span>
        {turn.model.split("/").slice(1).join("/")}
      </div>
      <ActivityLog
        client={client}
        id={turn.id}
        steps={turn.activity}
        recoverable={turn.status !== "answering"}
      />
      {turn.answer && (
        <div className="chat-answer" dir="auto">
          {turn.answer}
        </div>
      )}
      {turn.status === "answering" &&
        !turn.activity?.some((step) => step.status === "running") && (
          <span className="chat-status" role="status">
            {turn.answer ? t.chatStreaming : t.chatWaiting}
          </span>
        )}
      {(turn.status === "failed" || turn.status === "stopped") && (
        <div className="chat-failure">
          <span>
            {turn.status === "stopped"
              ? t.chatStopped
              : t.chatErrors[turn.error ?? "failed"]}
          </span>
          <button
            type="button"
            disabled={!canRetry}
            onClick={() => retry(turn)}
          >
            <RotateCcw size={12} />
            {t.askAgain}
          </button>
          {turn.detail && (
            <details>
              <summary>{t.errorDetails}</summary>
              <p>{turn.detail}</p>
            </details>
          )}
        </div>
      )}
    </article>
  );
});

export const Thread = memo(function Thread({
  client,
  retry,
  canRetry,
}: {
  client: ChatClient;
  retry: (turn: ChatTurn) => void;
  canRetry: boolean;
}) {
  const view = useSyncExternalStore(client.subscribe, client.read);
  const scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const lastQuestion = useRef("");
  const anchor = useRef<{ id: string; y: number } | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const saved = anchor.current;
    const last = view.turns.at(-1);
    if (last?.status === "answering" && last.id !== lastQuestion.current)
      follow.current = true;
    lastQuestion.current = last?.id ?? "";
    if (saved && view.turns[0]?.id !== saved.id) {
      const item = el.querySelector<HTMLElement>(
        '[data-question="' + CSS.escape(saved.id) + '"]',
      );
      if (item) el.scrollTop += item.getBoundingClientRect().top - saved.y;
      anchor.current = null;
    } else if (follow.current) el.scrollTop = el.scrollHeight;
  }, [view.turns]);
  return (
    <div
      className="chat-thread"
      ref={scroll}
      aria-label={t.chatHistory}
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 40;
      }}
    >
      {view.hasEarlier && (
        <button
          className="load-chat"
          disabled={loading}
          onClick={async () => {
            const first =
              scroll.current?.querySelector<HTMLElement>("[data-question]");
            if (first)
              anchor.current = {
                id: first.dataset.question!,
                y: first.getBoundingClientRect().top,
              };
            setLoading(true);
            setError("");
            try {
              await client.earlier();
            } catch (e) {
              setError(String(e));
              anchor.current = null;
            } finally {
              setLoading(false);
            }
          }}
        >
          {t.earlierQuestions}
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!view.turns.length && (
        <p className="chat-empty">
          {view.connected ? t.chatHint : t.chatConnecting}
        </p>
      )}
      {view.turns.map((turn) => (
        <Exchange
          key={turn.id}
          client={client}
          turn={turn}
          retry={retry}
          canRetry={canRetry}
        />
      ))}
    </div>
  );
});
