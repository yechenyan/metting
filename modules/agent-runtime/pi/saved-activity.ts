import { createReadStream } from "node:fs";
import { join } from "node:path";
import { finishActivity, type AgentActivity } from "../activity.ts";
import { PiActivity } from "./activity.ts";

function messageText(content: unknown) {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .filter((p) => p?.type === "text")
        .map((p) => p.text)
        .join("")
    : "";
}

// Older UI journals only stored the answer. Read the native journal on an explicit
// history request and return steps only when the original exchange is unambiguous.
export async function readSavedActivity(
  directory: string,
  matchesPrompt: (prompt: string) => boolean,
  answer: string,
) {
  const stream = createReadStream(join(directory, "pi-session.jsonl"), {
    encoding: "utf8",
  });
  let live: PiActivity | undefined;
  let steps = new Map<string, AgentActivity>();
  let lastAnswer = "";
  let match: AgentActivity[] = [];
  let matches = 0;
  function finish() {
    if (live && (!answer || lastAnswer.trim() === answer.trim())) {
      matches++;
      match = finishActivity(Array.from(steps.values()));
    }
  }
  try {
    let tail = "";
    for await (const chunk of stream) {
      const lines = (tail + chunk).split("\n");
      tail = lines.pop()!;
      for (const line of lines) {
        if (!line) continue;
        const entry = JSON.parse(line);
        if (entry.type !== "message") continue;
        const message = entry.message;
        if (message?.role === "user") {
          finish();
          lastAnswer = "";
          steps = new Map();
          live = matchesPrompt(messageText(message.content))
            ? new PiActivity((step) => steps.set(step.id, step))
            : undefined;
        } else if (live && message?.role === "assistant") {
          live.assistant(message, true);
          lastAnswer = messageText(message.content);
        } else if (live && message?.role === "toolResult")
          live.toolResult(message);
      }
    }
    finish();
    return matches === 1 ? match : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  } finally {
    stream.destroy();
  }
}
