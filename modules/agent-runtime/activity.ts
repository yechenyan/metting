export type ActivityStatus = "running" | "done" | "failed" | "interrupted";

export interface ToolStep {
  name: string;
  status: ActivityStatus;
  input?: string;
  output?: string;
  durationMs?: number;
}

export type AgentActivity =
  | {
      id: string;
      kind: "thinking";
      status: ActivityStatus;
      summary?: string;
      durationMs?: number;
    }
  | (ToolStep & {
      id: string;
      kind: "tool";
      target?: string;
      calls?: ToolStep[];
      moreCalls?: number;
    });

// An update replaces one step. Map insertion order preserves the start order of parallel calls.
export function mergeActivity(
  current: AgentActivity[] | undefined,
  changes: AgentActivity[],
) {
  const steps = new Map(current?.map((step) => [step.id, step]));
  for (const step of changes) steps.set(step.id, step);
  return Array.from(steps.values());
}

export function finishActivity(steps: AgentActivity[]) {
  return steps.map((step): AgentActivity => {
    const status = step.status === "running" ? "interrupted" : step.status;
    if (
      step.kind === "tool" &&
      step.calls?.some((call) => call.status === "running")
    )
      return {
        ...step,
        status,
        calls: step.calls.map((call) =>
          call.status === "running" ? { ...call, status: "interrupted" } : call,
        ),
      };
    return status === step.status ? step : { ...step, status };
  });
}
