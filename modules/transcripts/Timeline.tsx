import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AudioLines, ChevronsDown, Pencil, ChevronDown } from "lucide-react";
import { TranscriptClient, usePart } from "./client";
import { t, clock, nameOf, api } from "../../apps/web/lib";
import { Modal } from "../../apps/web/Modal";
import { UsagePanel } from "../agent-runtime/Usage";
import { SentenceDetails } from "./SentenceDetails";
import { draftScope } from "./drafts";
import { turnStart, turnTranslation } from "./reading";
import type { ReadingTurn } from "./types";
import {
  draftText,
  translatedText,
  type TranslationTarget,
} from "./translation";
import { useQuotation } from "./useQuotation";
import type { CaptionQuotation } from "./quotation";
import {
  RecordingPlayer,
  SentenceAudio,
  type PlaybackHandle,
  type SentencePlayback,
} from "../audio/Playback";
import { emptyAudio } from "../audio/timeline";
import type { RunState } from "../meetings/types";

const captionViews = ["source", "translation", "both"] as const;
type CaptionView = (typeof captionViews)[number];

const emptyMessages = {
  standby: [t.emptyTitle, t.emptyText],
  preparing: [t.warmTitle, t.warmText],
  recording: [t.listeningTitle, t.listeningText],
  stopping: [t.stopping, t.savingText],
  saved: [t.noRecordedSpeech, t.playSavedAudio],
};

function Empty({ state, hasAudio }: { state: RunState; hasAudio: boolean }) {
  const mode = hasAudio
    ? "saved"
    : state === "idle" || state === "interrupted"
      ? "standby"
      : state;
  const [title, hint] = emptyMessages[mode];
  return (
    <div className="empty" role="status">
      <div className="reader-empty">
        <AudioLines size={23} strokeWidth={1.5} aria-hidden="true" />
        <h2>{title}</h2>
        <p>{hint}</p>
      </div>
    </div>
  );
}
const Row = memo(function Row({
  client,
  id,
  raw,
  target,
  view,
  rename,
  inspect,
  turn,
  playback,
}: {
  client: TranscriptClient;
  id: string;
  raw: boolean;
  target: TranslationTarget;
  view: CaptionView;
  rename: (s: string) => void;
  inspect: (id: string) => void;
  turn?: ReadingTurn;
  playback: SentencePlayback;
}) {
  const row = usePart(client, id, () => client.rows.get(id)),
    names = usePart(client, "speakers", () => client.speakers);
  if (!row) return null;
  const multiple =
    row.spans &&
    (new Set(row.spans.map((s) => s.speaker)).size > 1 ||
      row.spans.some((s) => s.overlap));
  const speaker = row.speaker;
  const merged = turn && turn.ids.length > 1;
  const source = turn?.text || (!raw && row.edited) || row.raw;
  const sameLanguage = row.language === target;
  const finalTranslation =
    view !== "source" &&
    !sameLanguage &&
    (turn
      ? turnTranslation(turn, client.rows, target)
      : translatedText(row, target));
  const draft =
    !merged &&
    !sameLanguage &&
    view !== "source" &&
    !finalTranslation &&
    draftText(row, target);
  const translation = finalTranslation || draft;
  const showSource = view !== "translation" || sameLanguage;
  return (
    <article
      data-segment={id}
      className={"utterance " + (row.stage === "partial" ? "partial" : "")}
    >
      <div className="utterance-meta">
        <div className="speaker-line">
          <button
            className={
              "speaker-tag color-" + (parseInt(speaker.slice(1), 10) % 4 || 0)
            }
            onClick={() => rename(speaker)}
            disabled={speaker === "unknown"}
            title={nameOf(speaker, names)}
          >
            <span>
              {row.spans?.some((s) => s.overlap)
                ? t.overlap
                : nameOf(speaker, names)}
            </span>
          </button>
          <span
            className="stage-tag"
            data-settled={
              (row.stage === "final" &&
                !merged &&
                row.refinement !== "fallback") ||
              undefined
            }
          >
            {merged
              ? t.merged
              : row.edited && !raw
                ? t.revised
                : row.refinement === "fallback"
                  ? t.streamOnly
                  : t.stages[row.stage]}
          </span>
        </div>
        <div className="caption-tools">
          <SentenceAudio
            ids={turn?.ids ?? [id]}
            time={turnStart(row, turn, client.rows)}
            rows={client.rows}
            playback={playback}
          />
          <button
            className="compare-turn"
            type="button"
            aria-haspopup="dialog"
            title={t.sentenceDetails}
            aria-label={t.sentenceDetails}
            onClick={() => inspect(id)}
          >
            {t.compareCaption}
          </button>
        </div>
      </div>
      <button
        type="button"
        className="utterance-text"
        aria-haspopup="dialog"
        aria-description={t.captionGestures}
      >
        {showSource && (
          <span className="spoken" lang={row.language}>
            {source}
            {row.stage === "partial" && <i className="caret" />}
          </span>
        )}
        {translation && (
          <span
            className="translation"
            lang={target ?? undefined}
            data-draft={draft ? t.draftLabels[draftScope(row)] : undefined}
          >
            {translation}
          </span>
        )}
        {!showSource && !translation && (
          <span className="translation-pending">
            {row.stage === "partial"
              ? t.listeningForTranslation
              : t.awaitingTranslation}
          </span>
        )}
      </button>
      {multiple && (
        <details className="turns">
          <summary>
            {t.speakerTurns}
            <ChevronDown size={12} />
          </summary>
          {row.spans!.map((s, i) => (
            <div key={i}>
              <time>
                {clock(s.start)}–{clock(s.end)}
              </time>
              <button
                disabled={s.speaker === "unknown"}
                onClick={() => rename(s.speaker)}
              >
                {nameOf(s.speaker, names)}
              </button>
              {s.overlap && <span>{t.overlap}</span>}
            </div>
          ))}
        </details>
      )}
    </article>
  );
});
export function Timeline({
  client,
  target,
  editing,
  ask,
  quoting,
}: {
  client: TranscriptClient;
  target: TranslationTarget;
  editing: boolean;
  ask: (quotation: CaptionQuotation) => void;
  quoting: boolean;
}) {
  const sourceIds = usePart(client, "ids", () => client.ids),
    layoutVersion = usePart(client, "reading", () => client.readingVersion),
    state = usePart(client, "state", () => client.state),
    connected = usePart(client, "connection", () => client.connected);
  const savedAudio = usePart(client, "audio", () => client.audio);
  const audio =
    state.value === "idle" || state.value === "interrupted"
      ? savedAudio
      : emptyAudio;
  const player = useRef<PlaybackHandle>(null);
  const [playing, setPlaying] = useState("");
  const play = useCallback(
    (ids: string[]) => player.current?.sentence(ids),
    [],
  );
  const playback = useMemo(
    () => ({ audio, playing, play }),
    [audio, playing, play],
  );
  const [raw, setRaw] = useState(false),
    [renaming, setRenaming] = useState(""),
    [name, setName] = useState(""),
    [error, setError] = useState(""),
    [selected, setSelected] = useState("");
  const preference = "meeting.desk.captionView." + client.meeting;
  const [chosenView, setChosenView] = useState<CaptionView>(() => {
    const saved = localStorage.getItem(preference);
    return captionViews.find((v) => v === saved) ?? "both";
  });
  const view = target ? chosenView : "source";
  const ids = useMemo(
    () => (raw ? sourceIds : client.reading.order(sourceIds)),
    [client, raw, sourceIds, layoutVersion],
  );
  const scroll = useRef<HTMLDivElement>(null),
    quoteHost = useRef<HTMLDivElement>(null),
    sticky = useRef(true),
    [following, setFollowing] = useState(true);
  const interacting = useQuotation(scroll, quoteHost, client, raw, ask);
  const virt = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 55,
    overscan: 7,
    getItemKey: (i) => ids[i],
  });
  const total = virt.getTotalSize();
  useLayoutEffect(() => {
    virt.measure();
  }, [virt, view, target, raw]);
  const viewportHeight = virt.scrollRect?.height;
  useLayoutEffect(() => {
    if (
      sticky.current &&
      !quoting &&
      !interacting.current &&
      !window.getSelection()?.toString() &&
      scroll.current
    )
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [ids.length, total, viewportHeight, interacting, quoting]);
  useEffect(() => {
    sticky.current = true;
    setFollowing(true);
  }, [client]);
  const rename = useCallback(
    (s: string) => {
      setRenaming(s);
      setName(nameOf(s, client.speakers));
      setError("");
    },
    [client],
  );
  return (
    <section className="transcript-card" aria-label={t.liveTranscript}>
      <div className="quotation-host" ref={quoteHost} />
      <div className="scroll-wrap">
        <div
          className="transcript-scroll"
          ref={scroll}
          onScroll={() => {
            const el = scroll.current!;
            sticky.current =
              el.scrollHeight - el.clientHeight - el.scrollTop < 45;
            setFollowing(sticky.current);
          }}
        >
          {!ids.length ? (
            <Empty state={state.value} hasAudio={audio.volumeMs.length > 0} />
          ) : (
            <div className="virtual-space" style={{ height: total }}>
              {virt.getVirtualItems().map((r) => (
                <div
                  className="virtual-row"
                  key={r.key}
                  data-index={r.index}
                  ref={virt.measureElement}
                  style={{ transform: "translateY(" + r.start + "px)" }}
                >
                  <Row
                    playback={playback}
                    client={client}
                    id={ids[r.index]}
                    raw={raw}
                    target={target}
                    view={view}
                    rename={rename}
                    inspect={setSelected}
                    turn={raw ? undefined : client.reading.turn(ids[r.index])}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        {!following && (
          <button
            className="follow"
            onClick={() => {
              sticky.current = true;
              setFollowing(true);
              if (scroll.current)
                scroll.current.scrollTop = scroll.current.scrollHeight;
            }}
          >
            <ChevronsDown size={14} />
            {t.returnLive}
          </button>
        )}
      </div>
      {audio.volumeMs.length > 0 && (
        <RecordingPlayer
          key={audio.version}
          ref={player}
          meeting={client.meeting}
          manifest={audio}
          onPlaying={setPlaying}
        />
      )}
      <footer className="reader-foot">
        <select
          className="version-select"
          aria-label={t.transcriptVersion}
          title={t.transcriptVersion}
          value={raw ? "raw" : "edited"}
          onChange={(e) => setRaw(e.target.value === "raw")}
        >
          <option value="edited">{t.read}</option>
          <option value="raw">{t.rawTranscript}</option>
        </select>
        <div className="view-tabs" role="group" aria-label={t.captionDisplay}>
          {captionViews.map((mode) => (
            <button
              key={mode}
              disabled={!target && mode !== "source"}
              aria-pressed={view === mode}
              title={
                !target && mode !== "source"
                  ? t.enableTranslationView
                  : undefined
              }
              onClick={() => {
                setChosenView(mode);
                localStorage.setItem(preference, mode);
              }}
            >
              {t.captionViews[mode]}
            </button>
          ))}
        </div>
        <span className="reader-status">
          {!connected
            ? t.offline
            : state.value === "recording"
              ? t.localSaving
              : ids.length
                ? t.saved
                : ""}
          {connected && sourceIds.length > 0 && (
            <span>
              {ids.length === sourceIds.length
                ? sourceIds.length + t.entries
                : t.sourceCount.replace("{count}", String(sourceIds.length))}
            </span>
          )}
        </span>
        <UsagePanel client={client} />
      </footer>
      {selected && (
        <SentenceDetails
          playback={playback}
          client={client}
          id={selected}
          raw={raw}
          target={target}
          editing={editing}
          close={() => setSelected("")}
        />
      )}
      {renaming && (
        <Modal title={t.renameSpeaker} close={() => setRenaming("")}>
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("meetings/" + client.meeting + "/speaker", {
                  speaker: renaming,
                  name,
                });
                setRenaming("");
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            <label>
              {t.speakerName}
              <input
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
              />
            </label>
            <p className="muted">{t.speakerHint}</p>
            {error && <p className="error">{error}</p>}
            <footer>
              <button className="button primary">
                <Pencil size={15} />
                {t.save}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </section>
  );
}
