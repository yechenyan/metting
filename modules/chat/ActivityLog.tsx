import { memo, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Terminal,
} from "lucide-react";
import { t } from "../../apps/web/lib";
import type { AgentActivity, ActivityStatus } from "../agent-runtime/activity";
import type { ChatClient } from "./client";

const statusLabels = {
  running: t.activityRunning,
  done: t.activityDone,
  failed: t.activityFailed,
  interrupted: t.activityInterrupted,
} satisfies Record<ActivityStatus, string>;

function timing(ms?: number) {
  if (ms === undefined) return "";
  return ms < 1000
    ? Math.round(ms) + " ms"
    : Number((ms / 1000).toFixed(1)) + " s";
}
function State({
  status,
  duration,
}: {
  status: ActivityStatus;
  duration?: number;
}) {
  const Icon =
    status === "done" ? Check : status === "running" ? Clock3 : CircleAlert;
  return (
    <span className={"step-state " + status} title={statusLabels[status]}>
      <Icon size={12} aria-hidden="true" />
      {status !== "done" && statusLabels[status]}
      {status === "done" && (
        <span className="sr-only">{statusLabels.done}</span>
      )}
      {timing(duration)}
    </span>
  );
}

const Step = memo(function Step({ step }: { step: AgentActivity }) {
  const [open, setOpen] = useState(false);
  const tool = step.kind === "tool" ? step : undefined;
  const summary = step.kind === "thinking" ? step.summary : undefined;
  const Icon = tool ? Terminal : Brain;
  const title =
    tool?.name ?? (summary ? t.activityThinkingSummary : t.activityThinking);
  const nestedNames = tool?.calls?.length
    ? [...new Set(tool.calls.map((call) => call.name))].join(", ")
    : "";
  const target = nestedNames || tool?.target || summary;
  const detail = !!(
    tool?.input ||
    tool?.output ||
    tool?.calls?.length ||
    summary
  );
  const line = (
    <>
      <Icon size={13} aria-hidden="true" />
      <span className="step-name">{title}</span>
      <span className="step-target" dir="auto">
        {target}
      </span>
      <State status={step.status} duration={step.durationMs} />
    </>
  );
  if (!detail) return <div className="step-line">{line}</div>;
  return (
    <details
      className="step-details"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="step-line">
        {line}
        <ChevronRight className="step-chevron" size={11} aria-hidden="true" />
      </summary>
      {open && (
        <div className="step-body">
          {summary && <p dir="auto">{summary}</p>}
          {tool?.calls?.length ? (
            <ul className="nested-steps" aria-label={t.activityNested}>
              {tool.calls.map((call, index) => (
                <li key={index}>
                  <b>{call.name}</b>
                  <State status={call.status} duration={call.durationMs} />
                  {call.input && <code dir="auto">{call.input}</code>}
                  {call.output && <pre dir="auto">{call.output}</pre>}
                </li>
              ))}
              {!!tool.moreCalls && (
                <li>
                  {t.activityMoreCalls.replace("{n}", String(tool.moreCalls))}
                </li>
              )}
            </ul>
          ) : null}
          {tool?.input && (
            <>
              <span>{t.activityInput}</span>
              <pre dir="auto">{tool.input}</pre>
            </>
          )}
          {tool?.output && (
            <>
              <span>{t.activityOutput}</span>
              <pre dir="auto">{tool.output}</pre>
            </>
          )}
        </div>
      )}
    </details>
  );
});

export const ActivityLog = memo(function ActivityLog({
  client,
  id,
  steps,
  recoverable,
}: {
  client: ChatClient;
  id: string;
  steps?: AgentActivity[];
  recoverable: boolean;
}) {
  const [saved, setSaved] = useState<AgentActivity[]>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [all, setAll] = useState(false);
  const activity = steps ?? saved;
  if (!activity && recoverable)
    return (
      <div className="past-activity">
        <button
          type="button"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            setFailed(false);
            try {
              setSaved(await client.readActivity(id));
            } catch {
              setFailed(true);
            } finally {
              setLoading(false);
            }
          }}
        >
          <ChevronDown size={12} />
          {loading ? t.activityLoading : t.activityShowHistory}
        </button>
        {failed && <span role="alert">{t.activityLoadError}</span>}
      </div>
    );
  if (!activity?.length)
    return saved ? (
      <p className="past-activity">{t.activityUnavailable}</p>
    ) : null;
  const extra = Math.max(0, activity.length - 4);
  const visible =
    all || !extra
      ? activity
      : activity.filter((step, i) => i >= extra || step.status === "running");
  return (
    <section className="chat-activity" aria-label={t.activityTitle}>
      {(all || visible.length < activity.length) && extra > 0 && (
        <button
          type="button"
          className="step-more"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          <ChevronDown size={12} />
          {all
            ? t.activityCollapse
            : t.activityExpand.replace(
                "{n}",
                String(activity.length - visible.length),
              )}
        </button>
      )}
      {visible.map((step) => (
        <Step key={step.id} step={step} />
      ))}
    </section>
  );
});
