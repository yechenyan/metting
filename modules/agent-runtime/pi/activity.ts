import { stripVTControlCharacters } from "node:util";
import type { AgentActivity, ActivityStatus, ToolStep } from "../activity.ts";

type PiRecord = Record<string, any>;
type ToolActivity = Extract<AgentActivity, { kind: "tool" }>;
const previewLimit = 1600;
const nestedLimit = 16;

function clip(value: unknown, limit = previewLimit): string | undefined {
  if (typeof value !== "string" || !value) return;
  const text = value.length > limit ? value.slice(0, limit - 1) + "…" : value;
  return stripVTControlCharacters(text);
}

function previewValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return clip(value) ?? "";
  if (!value || typeof value !== "object") return value;
  if (depth >= 3) return "…";
  if ("type" in value && (value.type === "image" || value.type === "audio"))
    return "[" + value.type + "]";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 8)
      .map((item) => previewValue(item, depth + 1));
    if (value.length > items.length) items.push("…");
    return items;
  }
  const result: Record<string, unknown> = Object.create(null);
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (++count > 12) {
      result["…"] = "…";
      break;
    }
    result[key] = previewValue((value as PiRecord)[key], depth + 1);
  }
  return result;
}

function textBlocks(content: unknown, type: "text" | "summary_text") {
  if (!Array.isArray(content)) return;
  let text = "";
  for (const block of content) {
    if (block?.type !== type || typeof block.text !== "string" || !block.text)
      continue;
    text +=
      (text ? "\n" : "") + block.text.slice(0, previewLimit + 1 - text.length);
    if (text.length >= previewLimit) break;
  }
  return clip(text);
}

function jsonPreview(value: unknown) {
  if (value !== undefined)
    return clip(JSON.stringify(previewValue(value), null, 2));
}

function publicSummary(block: PiRecord, api: unknown) {
  if (
    block.redacted ||
    (api !== "openai-responses" && api !== "openai-codex-responses")
  )
    return;
  // Pi merges public summary deltas and other reasoning deltas. Only the Responses
  // item's explicitly typed summary is suitable for the sidebar.
  if (
    typeof block.thinkingSignature !== "string" ||
    !block.thinkingSignature.startsWith("{")
  )
    return;
  try {
    const item = JSON.parse(block.thinkingSignature);
    if (item.type === "reasoning")
      return textBlocks(item.summary, "summary_text");
  } catch {
    /* Other signature formats are opaque. */
  }
}

function duration(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}
function nestedCall(call: PiRecord): ToolStep {
  const status: ActivityStatus =
    call.status === "ok"
      ? "done"
      : call.status === "error"
        ? "failed"
        : call.status === "cancelled"
          ? "interrupted"
          : "running";
  return {
    name: clip(call.name, 100) ?? "tool",
    status,
    input: clip(call.args, 240),
    output: clip(call.error, 400),
    durationMs: duration(call.durationMs),
  };
}

export class PiActivity {
  private message = 0;
  private steps = new Map<string, AgentActivity>();
  private starts = new Map<string, number>();
  constructor(private publish: (step: AgentActivity) => void) {}
  private put(step: AgentActivity) {
    this.steps.set(step.id, step);
    this.publish(step);
  }
  private elapsed(id: string, now?: number) {
    const start = this.starts.get(id);
    return start === undefined || now === undefined
      ? undefined
      : duration(now - start);
  }
  private thinking(
    index: number,
    status: ActivityStatus,
    now?: number,
    summary?: string,
  ) {
    const id = "thinking:" + this.message + ":" + index;
    const previous = this.steps.get(id);
    if (status === "running" && now !== undefined) this.starts.set(id, now);
    this.put({
      id,
      kind: "thinking",
      status,
      summary,
      durationMs:
        status === "running"
          ? undefined
          : (previous?.durationMs ?? this.elapsed(id, now)),
    });
  }
  private tool(event: PiRecord, now?: number) {
    if (
      typeof event.toolCallId !== "string" ||
      typeof event.toolName !== "string"
    )
      return;
    const id = "tool:" + event.toolCallId;
    const previous = this.steps.get(id) as ToolActivity | undefined;
    const end = event.type === "tool_execution_end";
    if (event.type === "tool_execution_start" && now !== undefined)
      this.starts.set(id, now);
    const args = event.args;
    const result = end ? event.result : event.partialResult;
    const calls =
      event.toolName === "codemode" && Array.isArray(result?.details?.calls)
        ? result.details.calls
        : undefined;
    const target =
      previous?.target ??
      clip(
        args?.command ??
          args?.path ??
          args?.pattern ??
          args?.query ??
          args?.code,
        160,
      );
    const input = previous?.input ?? jsonPreview(args);
    const output =
      textBlocks(result?.content, "text") ??
      clip(result) ??
      jsonPreview(result?.structuredContent);
    this.put({
      id,
      kind: "tool",
      name: clip(event.toolName, 100) ?? "tool",
      target,
      input,
      status: end
        ? event.isError || result?.isError
          ? "failed"
          : "done"
        : "running",
      durationMs: end
        ? (duration(event.durationMs) ?? this.elapsed(id, now))
        : undefined,
      output: output ?? previous?.output,
      calls: calls
        ? calls.slice(0, nestedLimit).map(nestedCall)
        : previous?.calls,
      moreCalls: calls
        ? Math.max(0, calls.length - nestedLimit)
        : previous?.moreCalls,
    });
  }
  event(event: PiRecord, now: number | undefined = Date.now()) {
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_update" ||
      event.type === "tool_execution_end"
    ) {
      this.tool(event, now);
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "thinking_start" || update?.type === "thinking_end")
        this.thinking(
          update.contentIndex,
          update.type === "thinking_start" ? "running" : "done",
          now,
        );
    } else if (
      event.type === "message_end" &&
      event.message?.role === "assistant"
    ) {
      this.assistant(event.message);
    }
  }
  // Saved sessions have completed messages and tool results, without live delta events.
  assistant(message: PiRecord, replayCalls = false) {
    const status =
      message.stopReason === "aborted"
        ? "interrupted"
        : message.stopReason === "error"
          ? "failed"
          : "done";
    if (Array.isArray(message.content))
      message.content.forEach((block: PiRecord, index: number) => {
        if (block?.type === "thinking")
          this.thinking(
            index,
            status,
            undefined,
            publicSummary(block, message.api),
          );
        if (replayCalls && block?.type === "toolCall")
          this.tool({
            type: "tool_execution_start",
            toolCallId: block.id,
            toolName: block.name,
            args: block.arguments,
          });
      });
    this.message++;
  }
  toolResult(message: PiRecord) {
    this.tool({
      type: "tool_execution_end",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      result: message,
      durationMs: message.durationMs,
    });
  }
}
