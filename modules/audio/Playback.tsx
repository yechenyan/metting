import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Headphones, Pause, Play } from "lucide-react";
import { clock, t } from "../../apps/web/lib";
import type { Segment } from "../transcripts/types";
import type { AudioManifest } from "./timeline";
import "./playback.css";

export interface PlaybackHandle {
  sentence(ids: string[]): void;
}
export interface SentencePlayback {
  audio: AudioManifest;
  playing: string;
  play: (ids: string[]) => void;
}
export function SentenceAudio({
  ids,
  time,
  rows,
  playback,
}: {
  ids: string[];
  time: number;
  rows: ReadonlyMap<string, Segment>;
  playback: SentencePlayback;
}) {
  const available =
    playback.audio.coverage.length > 0 &&
    ids.some((id) => {
      const row = rows.get(id);
      return (
        row &&
        playback.audio.coverage.some(
          (r) => row.start < r.end && row.end > r.start && row.end > row.start,
        )
      );
    });
  const stamp = <time>{clock(time)}</time>;
  if (!available) return stamp;
  const active = playback.playing === JSON.stringify(ids);
  const label = active ? t.pauseSentence : t.playSentence;
  return (
    <button
      className="sentence-play"
      type="button"
      title={label}
      aria-label={label + " " + clock(time)}
      aria-pressed={active}
      onClick={() => playback.play(ids)}
    >
      {active ? <Pause size={11} /> : <Play size={11} />} {stamp}
    </button>
  );
}

export const RecordingPlayer = forwardRef<
  PlaybackHandle,
  {
    meeting: string;
    manifest: AudioManifest;
    onPlaying: (key: string) => void;
  }
>(function RecordingPlayer({ meeting, manifest, onPlaying }, ref) {
  const element = useRef<HTMLAudioElement>(null);
  const [selection, setSelection] = useState({ key: "", volume: 0 });
  const current = useRef(selection);
  const [error, setError] = useState(false);
  const base =
    "/api/meetings/" +
    encodeURIComponent(meeting) +
    "/audio?version=" +
    encodeURIComponent(manifest.version);
  useLayoutEffect(() => {
    const player = element.current!;
    player.src = base;
    return () => {
      player.pause();
      player.removeAttribute("src");
      player.load();
      onPlaying("");
    };
  }, [base, onPlaying]);
  function play(ids: string[], volume: number, toggle = false) {
    const player = element.current;
    if (!player) return;
    const next = { key: ids.length ? JSON.stringify(ids) : "", volume };
    const url =
      base +
      (volume ? "&volume=" + volume : "") +
      ids.map((id) => "&sentence=" + encodeURIComponent(id)).join("");
    setError(false);
    if (player.getAttribute("src") !== url) {
      current.current = next;
      setSelection(next);
      player.src = url;
    } else if (toggle && !player.paused) {
      player.pause();
      return;
    }
    if (player.ended) player.currentTime = 0;
    void player.play().catch((e) => {
      if (
        e.name !== "AbortError" &&
        element.current === player &&
        player.getAttribute("src") === url
      )
        setError(true);
    });
  }
  useImperativeHandle(ref, () => ({ sentence: (ids) => play(ids, 0, true) }));
  const sync = () =>
    onPlaying(element.current?.paused ? "" : current.current.key);
  return (
    <div className="recording-player">
      <Headphones size={14} aria-hidden="true" />
      {selection.key ? (
        <button type="button" onClick={() => play([], 0)}>
          {t.playWhole}
        </button>
      ) : (
        <span>{t.wholeRecording}</span>
      )}
      <audio
        ref={element}
        controls
        preload="none"
        aria-label={selection.key ? t.sentenceAudio : t.wholeRecording}
        onPlay={sync}
        onPause={sync}
        onError={(e) => {
          if (e.currentTarget.hasAttribute("src")) setError(true);
        }}
        onEnded={() => {
          onPlaying("");
          const { key, volume } = current.current;
          if (!key && volume + 1 < manifest.volumeMs.length)
            play([], volume + 1);
        }}
      />
      {manifest.volumeMs.length > 1 && !selection.key && (
        <select
          aria-label={t.audioVolume}
          value={selection.volume}
          onChange={(e) => play([], Number(e.target.value))}
        >
          {manifest.volumeMs.map((ms, i) => (
            <option key={i} value={i}>
              {i + 1} · {clock(ms)}
            </option>
          ))}
        </select>
      )}
      {error && <small role="alert">{t.playbackFailed}</small>}
    </div>
  );
});
