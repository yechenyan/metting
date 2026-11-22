import { useState } from "react";
import { Check, Copy, RefreshCw, TerminalSquare } from "lucide-react";
import { api, t } from "../../apps/web/lib";
import { Modal } from "../../apps/web/Modal";
import type { AgentInfo } from "./types";
export function Connection({
  runtime,
  refresh,
  close,
}: {
  runtime: AgentInfo | null;
  refresh: () => Promise<void>;
  close: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title={t.pi} close={close}>
      <div className="form">
        <div className="connection-state">
          <span className={"state-light " + (runtime?.ready ? "ready" : "")} />
          {runtime?.ready
            ? t.connected
            : runtime?.reason === "runtime"
              ? t.aiStates.runtime
              : runtime?.reason === "models"
                ? t.aiStates.models
                : t.unconnected}
        </div>
        <p className="muted">{runtime?.ready ? t.usageHint : t.loginHint}</p>
        {!runtime?.ready && (
          <>
            <button
              className="button primary"
              onClick={async () => {
                try {
                  await api("pi/login", {});
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              <TerminalSquare size={16} />
              {t.terminalLogin}
            </button>
            <div className="command">
              <code>npm run pi -- auth login openai</code>
              <button
                className="icon-btn"
                title={t.copy}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      "npm run pi -- auth login openai",
                    );
                    setCopied(true);
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <footer>
          <button
            className="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await refresh();
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={14} className={busy ? "spin" : ""} />
            {t.refresh}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
