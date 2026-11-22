import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  ChevronDown,
  FolderOpen,
  PanelRightClose,
  Plus,
  Square,
} from "lucide-react";
import { t } from "../../apps/web/lib";
import type { Meeting } from "../meetings/types";
import type { AgentInfo } from "../agent-runtime/types";
import { ChatClient } from "./client";
import { Thread } from "./Thread";
import { useThreads } from "./useThreads";
import { QuoteBubble } from "./QuoteBubble";
import type { CaptionQuotation } from "../transcripts/quotation";
import {
  chatLimits,
  defaultThread,
  type ChatReference,
  type ChatTurn,
} from "./types";
import "./chat.css";

function sendOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229
  ) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}
function Panel({
  compact,
  close,
  children,
}: {
  compact: boolean;
  close: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    el.showModal();
    return () => el.close();
  }, [compact]);
  return compact ? (
    <dialog
      className="chat-drawer"
      id="chat-panel"
      ref={dialog}
      aria-label={t.chatTitle}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === dialog.current) close();
      }}
    >
      <div className="chat-panel">{children}</div>
    </dialog>
  ) : (
    <aside className="chat-panel" id="chat-panel" aria-label={t.chatTitle}>
      {children}
    </aside>
  );
}
interface ModelChoice {
  model: string;
  thinking: string;
}
function savedChoice(key: string): Partial<ModelChoice> {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") || {};
  } catch {
    return {};
  }
}
function ChatTokens({ client }: { client: ChatClient }) {
  const tokens = useSyncExternalStore(
    client.subscribe,
    () => client.read().totalTokens,
  );
  const live = useSyncExternalStore(client.subscribe, () => {
    const last = client.read().turns.at(-1);
    return last?.status === "answering" ? (last.liveTokens ?? 0) : 0;
  });
  return (
    <span className="chat-tokens">
      {t.chatTokens} <b>{tokens.toLocaleString()}</b>
      {live > 0 && (
        <small title={t.runningTokens}> +{live.toLocaleString()}</small>
      )}
    </span>
  );
}
interface WorkspaceProps {
  endpoint: string;
  meeting: Meeting;
  projectFolder: string;
  editProject: () => void;
  pi: AgentInfo | null;
  login: () => void;
  compact: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  quotation: CaptionQuotation | null;
  clearQuotation: (quote: CaptionQuotation) => void;
  revealReply: () => void;
}
export function ChatWorkspace(props: WorkspaceProps) {
  const threads = useThreads(
    props.meeting.id,
    props.endpoint,
    props.open || !!props.quotation,
  );
  const drafts = useRef(new Map<string, string>());
  return (
    <ActiveChat
      key={threads.selected}
      {...props}
      threads={threads}
      drafts={drafts.current}
    />
  );
}
function ActiveChat({
  meeting,
  projectFolder,
  editProject,
  endpoint,
  pi,
  login,
  compact,
  open,
  setOpen,
  quotation,
  clearQuotation,
  revealReply,
  threads,
  drafts,
}: WorkspaceProps & {
  threads: ReturnType<typeof useThreads>;
  drafts: Map<string, string>;
}) {
  const threadId = threads.selected;
  const client = useMemo(
    () => new ChatClient(meeting.id, endpoint, threadId),
    [meeting.id, endpoint, threadId],
  );
  const observing = open || !!quotation;
  useEffect(() => {
    if (observing) return client.open();
  }, [client, observing]);
  const key = "meeting.desk.chat.model." + meeting.id;
  const [choice, setChoice] = useState(() => savedChoice(key));
  const models = pi?.models ?? [];
  const model =
    models.find((m) => m.id === (choice.model ?? meeting.settings.model)) ??
    models[0];
  const levels = model?.levels.length ? model.levels : ["off"];
  const wanted = choice.thinking ?? meeting.settings.thinking;
  const thinking = levels.includes(wanted) ? wanted : levels[0];
  const active = useSyncExternalStore(client.subscribe, client.active);
  const connected = useSyncExternalStore(client.subscribe, client.connected);
  const [posting, setPosting] = useState(false),
    lock = useRef(false);
  const [draft, setDraft] = useState(() => drafts.get(threadId) ?? ""),
    [error, setError] = useState<{
      message: string;
      reference: ChatReference | null;
    } | null>(null);
  const ready = !!pi?.ready && !!model;
  const busy = !!active || posting;
  const input = useRef<HTMLTextAreaElement>(null);
  const folderTitle = projectFolder
    ? t.chatFolder.replace("{folder}", projectFolder)
    : t.defaultChatFolder;
  const unnamed =
    threads.threads.some((thread) => thread.id === threadId && !thread.title) &&
    threadId !== defaultThread;
  const refreshThreads = threads.refresh;
  function choose(patch: Partial<ModelChoice>) {
    const next = { ...choice, ...patch };
    setChoice(next);
    localStorage.setItem(key, JSON.stringify(next));
  }
  const send = useCallback(
    async (question: string, quote: ChatReference | null) => {
      if (
        !question.trim() ||
        !model ||
        !ready ||
        lock.current ||
        client.active()
      )
        return false;
      setError(null);
      setPosting(true);
      lock.current = true;
      try {
        await client.submit({
          question: question.trim(),
          reference: quote,
          model: model.id,
          thinking,
        });
        if (unnamed) void refreshThreads();
        return true;
      } catch (e) {
        setError({
          reference: quote,
          message:
            e instanceof Error && e.message === "chatBusy"
              ? t.chatBusy
              : t.chatSendFailed,
        });
        return false;
      } finally {
        lock.current = false;
        setPosting(false);
      }
    },
    [client, model, thinking, ready, unnamed, refreshThreads],
  );
  const retry = useCallback(
    (turn: ChatTurn) => {
      void send(turn.question, turn.reference);
    },
    [send],
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await send(draft, null)) {
      if (drafts.get(threadId) === draft) drafts.delete(threadId);
      setDraft((current) => (current === draft ? "" : current));
      input.current?.focus();
    }
  };
  const dismiss = useCallback(() => {
    if (quotation) {
      clearQuotation(quotation);
      setError((current) =>
        current?.reference === quotation.reference ? null : current,
      );
    }
  }, [quotation, clearQuotation]);
  return (
    <>
      {open && (
        <Panel compact={compact} close={() => setOpen(false)}>
          <header className="chat-head">
            <h2>{t.chatTitle}</h2>
            <button
              type="button"
              className="chat-folder"
              onClick={editProject}
              title={folderTitle}
              aria-label={folderTitle}
            >
              <FolderOpen size={13} />
              <span>
                {projectFolder.split("/").filter(Boolean).at(-1) ||
                  t.projectFolder}
              </span>
            </button>
            <button
              className="icon-btn"
              onClick={() => setOpen(false)}
              aria-label={t.closeChat}
              title={t.closeChat}
            >
              <PanelRightClose size={16} />
            </button>
          </header>
          <nav className="chat-thread-picker" aria-label={t.chatThread}>
            <label className="chat-thread-select">
              <select
                aria-label={t.chatThread}
                value={threadId}
                disabled={threads.creating}
                onFocus={() => void threads.refresh()}
                onChange={(e) => threads.choose(e.target.value)}
              >
                {threads.threads.map((thread, index) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title ||
                      (index === 0
                        ? t.defaultChatThread
                        : t.numberedChatThread.replace(
                            "{number}",
                            String(index + 1),
                          ))}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </label>
            <button
              type="button"
              onClick={() => void threads.create()}
              disabled={threads.creating}
            >
              <Plus size={13} />
              {t.newChatThread}
            </button>
          </nav>
          {threads.error && (
            <p className="error chat-thread-error" role="alert">
              {threads.error}
            </p>
          )}
          <Thread
            client={client}
            retry={retry}
            canRetry={ready && connected && !busy}
          />
          <form className="chat-compose" onSubmit={submit}>
            {error &&
              (!quotation || error.reference !== quotation.reference) && (
                <p className="error" role="alert">
                  {error.message}
                </p>
              )}
            {pi && !ready && (
              <button className="chat-login" type="button" onClick={login}>
                {t.connect}
              </button>
            )}
            <div className="chat-input">
              <textarea
                ref={input}
                aria-label={t.chatInput}
                placeholder={t.chatInput}
                rows={2}
                maxLength={chatLimits.question}
                value={draft}
                onChange={(e) => {
                  drafts.set(threadId, e.target.value);
                  setDraft(e.target.value);
                }}
                onKeyDown={sendOnEnter}
              />
              {active ? (
                <button
                  type="button"
                  className="chat-send"
                  aria-label={t.stopAnswer}
                  title={t.stopAnswer}
                  onClick={() =>
                    void client.stop(active).catch(() =>
                      setError({
                        message: t.chatStopFailed,
                        reference: null,
                      }),
                    )
                  }
                >
                  <Square size={12} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="chat-send"
                  disabled={!connected || !ready || busy || !draft.trim()}
                  aria-label={t.sendQuestion}
                  title={t.sendQuestion}
                >
                  <ArrowUp size={17} />
                </button>
              )}
            </div>
            <div className="chat-options">
              <label title={t.model}>
                <select
                  aria-label={t.chatModel}
                  disabled={!models.length}
                  value={model?.id ?? ""}
                  onChange={(e) => choose({ model: e.target.value })}
                >
                  {!models.length && <option value="">{t.model}</option>}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={11} />
              </label>
              <label title={t.thinking}>
                <select
                  aria-label={t.thinking}
                  disabled={!model}
                  value={thinking}
                  onChange={(e) => choose({ thinking: e.target.value })}
                >
                  {levels.map((level) => (
                    <option key={level} value={level}>
                      {t.thinking} · {t[level as keyof ModelLevels] || level}
                    </option>
                  ))}
                </select>
                <ChevronDown size={11} />
              </label>
              <ChatTokens client={client} />
            </div>
          </form>
        </Panel>
      )}
      {quotation && (
        <QuoteBubble
          key={quotation.reference.ids[0] + ":" + quotation.reference.text}
          quotation={quotation}
          busy={busy}
          ready={ready}
          login={login}
          dismiss={dismiss}
          error={error?.reference === quotation.reference ? error.message : ""}
          submit={async (question) => {
            if (await send(question, quotation.reference)) {
              clearQuotation(quotation);
              revealReply();
            }
          }}
        />
      )}
    </>
  );
}
type ModelLevels = Pick<
  typeof t,
  "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "off"
>;
