import { Cpu, ChevronRight } from "lucide-react";
import { memo, useState } from "react";
import { t } from "../../apps/web/lib";
import { Modal } from "../../apps/web/Modal";
import { TranscriptClient, usePart } from "../transcripts/client";
const num = new Intl.NumberFormat("zh-CN");
export const UsagePanel = memo(function UsagePanel({
  client,
}: {
  client: TranscriptClient;
}) {
  const u = usePart(client, "usage", () => client.usage),
    live = usePart(client, "runningTokens", () => client.runningTokens);
  const ai = usePart(client, "ai", () => client.ai),
    [details, setDetails] = useState(false);
  return (
    <>
      <button
        className="token-button"
        title={t.details}
        onClick={() => setDetails(true)}
      >
        <Cpu size={14} />
        <span>
          Token <b>{num.format(u.total)}</b>
        </span>
        {live > 0 && <small title={t.runningTokens}>+{num.format(live)}</small>}
        <ChevronRight size={12} />
      </button>
      {details && (
        <Modal title={t.details} close={() => setDetails(false)}>
          <p className="muted">{t.usageHint}</p>
          <dl className="facts">
            {[
              [t.meetingTotal, num.format(u.total)],
              [t.input, num.format(u.input)],
              [t.output, num.format(u.output)],
              [t.cacheRead, num.format(u.cacheRead)],
              [t.cacheWrite, num.format(u.cacheWrite)],
              ...(live > 0 ? [[t.runningTokens, num.format(live)]] : []),
              [t.requests, u.requests],
              [
                t.context,
                u.context === null || !u.window
                  ? t.waitingUsage
                  : num.format(u.context) +
                    " / " +
                    num.format(u.window) +
                    " (" +
                    num.format(Math.round((1000 * u.context) / u.window) / 10) +
                    "%)",
              ],
              [t.subscription, t.notReported],
              [t.ai, t.aiStates[ai as keyof typeof t.aiStates] || ai],
            ].map(([a, b]) => (
              <div key={a}>
                <dt>{a}</dt>
                <dd>{b}</dd>
              </div>
            ))}
          </dl>
          <p className="muted">{t.piQuota}</p>
        </Modal>
      )}
    </>
  );
});
