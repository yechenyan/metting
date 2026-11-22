import { useEffect, useState } from "react";
import {
  Play,
  Square,
  LoaderCircle,
  Languages,
  ArrowRight,
  SlidersHorizontal,
  Volume2,
  Mic,
  Sparkles,
  Check,
  RotateCw,
} from "lucide-react";
import { api, t, clock } from "../../apps/web/lib";
import { Modal } from "../../apps/web/Modal";
import { TranscriptClient, usePart } from "../transcripts/client";
import type { Meeting, Settings } from "./types.ts";
import { millisecondsPerMinute } from "../projects/recording-limit";
import type { AgentInfo } from "../agent-runtime/types.ts";
import { languages, type Language } from "../speech/types.ts";
import { AudioSourcePicker, useAudioSources } from "../speech/AudioSource";
import { TranslationSelect } from "../transcripts/TranslationSelect";
import {
  translationSettings,
  translationTarget,
} from "../transcripts/translation";

function Duration({
  client,
  limitMinutes,
}: {
  client: TranscriptClient;
  limitMinutes: number;
}) {
  const s = usePart(client, "state", () => client.state),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (s.value !== "recording") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [s.value, s.at]);
  const elapsed =
    s.elapsed + (s.value === "recording" ? Math.max(0, now - s.at) : 0);
  const limit = limitMinutes * millisecondsPerMinute;
  const time = clock(elapsed, true);
  const budget = t.recordingBudget
    .replace("{elapsed}", time)
    .replace("{limit}", clock(limit, true));
  return (
    <span
      className="time-display"
      data-running={s.value === "recording" || undefined}
      title={budget}
    >
      <time aria-label={budget}>{time}</time>
    </span>
  );
}
function Meter({ client, index }: { client: TranscriptClient; index: number }) {
  const level = usePart(client, "levels", () => client.levels[index] || 0);
  return (
    <span className="meter" title={index ? t.mic : t.system}>
      {index ? <Mic size={13} /> : <Volume2 size={14} />}
      <span>
        {Array.from({ length: 5 }, (_, i) => (
          <i
            key={i}
            style={{ height: 5 + i * 2 }}
            className={level > i / 5 + 0.008 ? "on" : ""}
          />
        ))}
      </span>
    </span>
  );
}
export function Controls({
  client,
  meeting,
  maxRecordingMinutes,
  pi,
  activeOther,
  change,
  onActive,
  error,
  login,
}: {
  client: TranscriptClient;
  meeting: Meeting;
  maxRecordingMinutes: number;
  pi: AgentInfo | null;
  activeOther: boolean;
  change: (v: Partial<Settings>) => Promise<void>;
  onActive: () => void;
  error: (s: string) => void;
  login: () => void;
}) {
  const state = usePart(client, "state", () => client.state),
    connected = usePart(client, "connection", () => client.connected);
  const local = usePart(
    client,
    "localTranslation",
    () => client.localTranslation,
  );
  const [options, setOptions] = useState(false),
    [busy, setBusy] = useState(false),
    [savingSource, setSavingSource] = useState(false);
  const active = ["preparing", "recording", "stopping"].includes(state.value),
    exhausted =
      !active && state.elapsed >= maxRecordingMinutes * millisecondsPerMinute,
    cfg = meeting.settings;
  const localNotice =
    cfg.localTranslation !== false &&
    cfg.translate &&
    cfg.language !== cfg.translationLanguage &&
    (local.state === "downloading" || local.state === "failed")
      ? t.localStates[local.state]
      : undefined;
  const inputs = useAudioSources(cfg, active);
  const selectedModel =
    pi?.models.find((m) => m.id === cfg.model) || pi?.models[0];
  const levels = selectedModel?.levels || [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ];
  const update = (v: Partial<Settings>) =>
    change(v).catch((e) => error(String(e)));
  async function changeSource(values: Partial<Settings>) {
    setSavingSource(true);
    try {
      await update(values);
    } finally {
      setSavingSource(false);
    }
  }
  async function toggle() {
    setBusy(true);
    try {
      await api("meetings/" + meeting.id + (active ? "/stop" : "/start"), {});
      onActive();
    } catch (e) {
      error(String(e));
    } finally {
      setBusy(false);
    }
  }
  const inputControls = (
    <>
      <AudioSourcePicker
        settings={cfg}
        inputs={inputs}
        disabled={active || busy || savingSource}
        change={changeSource}
      />
      <div className="capture-lang">
        <Languages size={17} />
        <select
          aria-label={t.language}
          value={cfg.language}
          disabled={active}
          onChange={(e) =>
            void update({ language: e.target.value as Language })
          }
        >
          {languages.map((key) => (
            <option value={key} key={key}>
              {t.langNames[key]}
            </option>
          ))}
        </select>
        <ArrowRight
          size={13}
          className="language-direction"
          aria-hidden="true"
        />
        <TranslationSelect
          value={translationTarget(cfg)}
          label={t.translationLanguage}
          change={(target) => void update(translationSettings(target))}
        />
      </div>
    </>
  );
  return (
    <>
      <div className="capture-bar">
        <div className="capture-inputs inline-inputs">{inputControls}</div>
        {state.value === "recording" && (
          <div className="meters">
            <Meter client={client} index={cfg.source === "system" ? 0 : 1} />
          </div>
        )}
        <Duration client={client} limitMinutes={maxRecordingMinutes} />
        <span className="sr-only" role="status">
          {t.runStates[state.value]}
        </span>
        <button
          className={"capture-button " + (active ? "capturing" : "")}
          disabled={
            busy ||
            !connected ||
            state.value === "stopping" ||
            activeOther ||
            exhausted ||
            (!active && (savingSource || !!inputs.unavailable))
          }
          title={
            exhausted
              ? t.recordingLimitAction
              : activeOther
                ? t.recordingElsewhere
                : inputs.unavailable || undefined
          }
          onClick={toggle}
        >
          {state.value === "preparing" || state.value === "stopping" || busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : active ? (
            <Square size={14} fill="currentColor" />
          ) : (
            <Play size={14} fill="currentColor" />
          )}
          <span>
            {state.value === "stopping"
              ? t.stopping
              : active
                ? t.stop
                : exhausted
                  ? t.recordingLimitLabel
                  : t.start}
          </span>
        </button>
        <button
          className="icon-btn controls-settings"
          data-notice={localNotice ? "" : undefined}
          title={localNotice ? t.settings + " · " + localNotice : t.settings}
          aria-label={t.settings}
          aria-description={localNotice}
          onClick={() => setOptions(true)}
        >
          <SlidersHorizontal size={16} />
          {localNotice && <span className="local-status">{localNotice}</span>}
        </button>
      </div>
      {options && (
        <Modal title={t.settings} close={() => setOptions(false)}>
          <div className="form">
            <div className="compact-input-settings">
              <span>
                {t.audioSource} · {t.language}
              </span>
              <div className="capture-inputs">{inputControls}</div>
            </div>
            <div className="form-split">
              <span>{t.localDraft}</span>
              <label className="switch-label">
                <input
                  aria-label={t.localDraft}
                  type="checkbox"
                  checked={cfg.localTranslation !== false}
                  onChange={(e) =>
                    void update({ localTranslation: e.target.checked })
                  }
                />
                <span className="toggle" />
              </label>
            </div>
            <small className="muted">
              {t.localModel} · {t.localStates[local.state]}
            </small>
            {local.state === "failed" && cfg.localTranslation !== false && (
              <button
                className="button"
                title={local.detail}
                onClick={() =>
                  void api(
                    "meetings/" + meeting.id + "/retry-translation",
                    {},
                  ).catch((e) => error(String(e)))
                }
              >
                {t.retryLocal}
              </button>
            )}
            <div className="form-split">
              <span>
                <Sparkles size={16} /> {t.ai}
              </span>
              <label className="switch-label">
                <input
                  aria-label={t.ai}
                  type="checkbox"
                  checked={cfg.editing}
                  onChange={(e) => void update({ editing: e.target.checked })}
                />
                <span className="toggle" />
              </label>
            </div>
            <small className="muted">{t.editEnabledHint}</small>
            <label>
              {t.model}
              <select
                value={cfg.model}
                onChange={(e) => void update({ model: e.target.value })}
              >
                <option value="">
                  {t.autoModel}
                  {pi?.models[0] ? " · " + pi.models[0].label : ""}
                </option>
                {pi?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.thinking}
              <select
                value={levels.includes(cfg.thinking) ? cfg.thinking : levels[0]}
                onChange={(e) => void update({ thinking: e.target.value })}
              >
                {levels.map((k) => (
                  <option key={k} value={k}>
                    {String(t[k as keyof typeof t] || k)}
                  </option>
                ))}
              </select>
            </label>
            {!pi?.ready && (
              <button
                className="button"
                onClick={() => {
                  setOptions(false);
                  login();
                }}
              >
                {t.connect}
              </button>
            )}
            {pi?.ready && cfg.editing && (
              <button
                className="button"
                title={t.organizeHint}
                onClick={async () => {
                  try {
                    await api("meetings/" + meeting.id + "/organize", {});
                    setOptions(false);
                  } catch (e) {
                    error(String(e));
                  }
                }}
              >
                <RotateCw size={15} />
                {t.organize}
              </button>
            )}
            <small className="muted">{t.permissionsHint}</small>
            <footer>
              <button
                className="button primary"
                onClick={() => setOptions(false)}
              >
                <Check size={15} />
                {t.close}
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </>
  );
}
