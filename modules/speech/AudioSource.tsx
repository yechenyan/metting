import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, RefreshCw } from "lucide-react";
import { api, t } from "../../apps/web/lib";
import type { Settings } from "../meetings/types";
import type { InputCatalog } from "./types";

export function useAudioSources(settings: Settings, active: boolean) {
  const [catalog, setCatalog] = useState<InputCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const loading = useRef(false);
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      setCatalog(await api<InputCatalog>("inputs"));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      loading.current = false;
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (active) return;
    const media = navigator.mediaDevices;
    window.addEventListener("focus", refresh);
    media?.addEventListener("devicechange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      media?.removeEventListener("devicechange", refresh);
    };
  }, [active, refresh]);
  const device = catalog?.devices.find(
    (d) => d.id === (settings.inputDevice || catalog.defaultId),
  );
  const app = catalog?.applications.find((a) => a.id === settings.application);
  let unavailable = "";
  if (catalog && !failed) {
    if (settings.source === "system" && settings.application && !app)
      unavailable = t.unavailableApp;
    if (settings.source === "mic") {
      if (!device) unavailable = t.unavailableInput;
      else if (settings.inputChannel > device.channels.length)
        unavailable = t.unavailableChannel;
    }
  }
  return { catalog, device, app, unavailable, failed, refresh };
}

function channelLabel(number: number, name?: string) {
  const label = t.channelNumber.replace("{number}", String(number));
  return name ? label + " · " + name : label;
}

export function AudioSourcePicker({
  settings,
  inputs,
  disabled,
  change,
}: {
  settings: Settings;
  inputs: ReturnType<typeof useAudioSources>;
  disabled: boolean;
  change: (settings: Partial<Settings>) => void;
}) {
  const { catalog, device, app, unavailable, failed, refresh } = inputs;
  const isInput = settings.source === "mic";
  const value = isInput
    ? "input:" + settings.inputDevice
    : settings.application
      ? "app:" + settings.application
      : "system";
  const defaultName = catalog?.devices.find(
    (d) => d.id === catalog.defaultId,
  )?.name;
  const defaultLabel = [
    t.defaultInput,
    defaultName || (catalog && t.unavailableInput),
  ]
    .filter(Boolean)
    .join(" · ");
  const deviceLabel =
    device?.name || (catalog ? t.unavailableInput : t.savedInput);
  function select(value: string) {
    if (value.startsWith("input:"))
      change({ source: "mic", inputDevice: value.slice(6), inputChannel: 1 });
    else
      change({
        source: "system",
        application: value === "system" ? "" : value.slice(4),
      });
  }
  return (
    <div className="source-picker capture-lang">
      <AudioLines size={16} aria-hidden="true" />
      <select
        aria-label={t.audioSource}
        title={
          unavailable || (isInput ? deviceLabel : app?.name || t.systemAudio)
        }
        disabled={disabled}
        value={value}
        onFocus={refresh}
        onPointerDown={refresh}
        onChange={(e) => select(e.target.value)}
      >
        <option value="system">{t.systemAudio}</option>
        <optgroup label={t.inputDevices}>
          <option value="input:">{defaultLabel}</option>
          {isInput && settings.inputDevice && !device && (
            <option value={value} disabled>
              {deviceLabel}
            </option>
          )}
          {catalog?.devices.map((d) => (
            <option key={d.id} value={"input:" + d.id}>
              {d.name}
            </option>
          ))}
        </optgroup>
        <optgroup label={t.application}>
          {!isInput && settings.application && !app && (
            <option value={value} disabled>
              {settings.application}
              {catalog && " · " + t.unavailableApp}
            </option>
          )}
          {catalog?.applications.map((a) => (
            <option key={a.id} value={"app:" + a.id}>
              {a.name}
            </option>
          ))}
        </optgroup>
      </select>
      {isInput &&
        ((device?.channels.length ?? 0) > 1 || settings.inputChannel > 1) && (
          <select
            className="channel-picker"
            aria-label={t.inputChannel}
            title={channelLabel(
              settings.inputChannel,
              device?.channels[settings.inputChannel - 1],
            )}
            disabled={disabled || !device}
            value={settings.inputChannel}
            onChange={(e) => change({ inputChannel: Number(e.target.value) })}
          >
            {settings.inputChannel > (device?.channels.length ?? 0) && (
              <option value={settings.inputChannel} disabled>
                {channelLabel(settings.inputChannel, t.unavailableChannel)}
              </option>
            )}
            {device?.channels.map((name, i) => (
              <option key={i} value={i + 1}>
                {channelLabel(i + 1, name)}
              </option>
            ))}
          </select>
        )}
      {failed && !disabled && (
        <button
          type="button"
          className="small-icon"
          title={t.inputsLoadFailed}
          aria-label={t.inputsLoadFailed}
          onClick={refresh}
        >
          <RefreshCw size={13} />
        </button>
      )}
    </div>
  );
}
