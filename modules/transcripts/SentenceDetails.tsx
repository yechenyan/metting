import { Modal } from "../../apps/web/Modal";
import { SentenceAudio, type SentencePlayback } from "../audio/Playback";
import { clock, nameOf, t } from "../../apps/web/lib";
import { TranscriptClient, usePart } from "./client";
import { streamingResult } from "./recognition";
import { draftScope } from "./drafts";
import { turnTranslation } from "./reading";
import {
  draftText,
  translatedText,
  type TranslationTarget,
} from "./translation";
import { targetName } from "./TranslationSelect";

function SourceVersions({
  client,
  id,
  target,
  editing,
  playback,
}: {
  client: TranscriptClient;
  id: string;
  target: TranslationTarget;
  editing: boolean;
  playback: SentencePlayback;
}) {
  const row = usePart(client, id, () => client.rows.get(id));
  const names = usePart(client, "speakers", () => client.speakers);
  const ai = usePart(client, "ai", () => client.ai);
  const run = usePart(client, "state", () => client.state.value);
  if (!row) return <p className="muted">{t.sourceUnavailable}</p>;
  const stream = streamingResult(row);
  const translation = translatedText(row, target);
  const local = draftText(row, target);
  const scope = local ? draftScope(row) : "current";
  const full =
    row.stage === "final" && row.refinement !== "fallback"
      ? row.raw
      : undefined;
  const shared =
    stream &&
    (row.id !== stream.id ||
      row.start !== stream.start ||
      row.end !== stream.end);
  const aiState = !editing
    ? t.editDisabled
    : ai === "working" || ai === "queued"
      ? t.aiStates[ai]
      : ai === "idle"
        ? t.noAiVersion
        : t.aiStates[ai as keyof typeof t.aiStates] || t.noAiVersion;
  return (
    <section className="source-versions">
      <h3>
        {nameOf(row.speaker, names)}{" "}
        <SentenceAudio
          ids={[id]}
          time={row.start}
          rows={client.rows}
          playback={playback}
        />
        <time>–{clock(row.end)}</time>
        {row.captureSource && <small> · {t[row.captureSource]}</small>}
      </h3>
      <dl className="version-list">
        <dt>{t.levelLive}</dt>
        <dd className={stream ? undefined : "muted"}>
          {stream?.text || t.noLiveVersion}
          {stream?.lastPartial && (
            <small>
              {t.lastPartial} · {stream.lastPartial}
            </small>
          )}
          {shared && (
            <small>
              {t.sharedLiveRange} · {clock(stream.start)}–{clock(stream.end)}
            </small>
          )}
        </dd>
        <dt>{t.levelSentence}</dt>
        <dd className={full ? undefined : "muted"}>
          {full ||
            (row.refinement === "fallback"
              ? t.refinementFallback
              : row.stage === "interrupted" ||
                  run === "idle" ||
                  run === "interrupted"
                ? t.noSentenceVersion
                : t.waitingSentence)}
          {full && !row.refinement && <small>{t.legacySentence}</small>}
        </dd>
        {local && (
          <>
            <dt>{scope === "current" ? t.localDraft : t.draftLabels[scope]}</dt>
            <dd lang={target ?? undefined}>
              {local}
              {scope !== "current" && (
                <small lang={row.language}>
                  {row.draftTranslation?.source}
                </small>
              )}
            </dd>
          </>
        )}
        <dt>{t.levelAi}</dt>
        <dd className={row.edited ? undefined : "muted"}>
          {row.edited || aiState}
        </dd>
        {target && row.language !== target && (
          <>
            <dt>
              {t.translation} · {targetName(target)}
            </dt>
            <dd lang={target} className={translation ? undefined : "muted"}>
              {translation || t.noTranslation}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

export function SentenceDetails({
  client,
  id,
  raw,
  editing,
  target,
  close,
  playback,
}: {
  client: TranscriptClient;
  id: string;
  raw: boolean;
  editing: boolean;
  target: TranslationTarget;
  close: () => void;
  playback: SentencePlayback;
}) {
  usePart(client, "reading", () => client.readingVersion);
  const turn = client.reading.turn(id);
  const merged = turn && turn.ids.length > 1 ? turn : undefined;
  const sources = merged && !raw ? merged.ids : [id];
  const translation =
    merged && target ? turnTranslation(merged, client.rows, target) : undefined;
  return (
    <Modal title={t.sentenceDetails} close={close}>
      {merged && (
        <section className="merged-version">
          <h3>
            {t.mergedVersion} ·{" "}
            {t.sourceCount.replace("{count}", String(merged.ids.length))}
          </h3>
          <p>{merged.text}</p>
          {translation && <p className="translation">{translation}</p>}
        </section>
      )}
      {sources.map((source) => (
        <SourceVersions
          playback={playback}
          key={source}
          client={client}
          id={source}
          target={target}
          editing={editing}
        />
      ))}
    </Modal>
  );
}
