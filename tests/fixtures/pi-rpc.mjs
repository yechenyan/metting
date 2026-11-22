import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv[2] === "-p") {
  console.log("24.0.0");
  process.exit(0);
}
function record(value) {
  appendFileSync(
    process.env.PI_FIXTURE_LOG,
    JSON.stringify({ pid: process.pid, ...value }) + "\n",
  );
}
function emit(value) {
  console.log(JSON.stringify(value));
}
record({ argv: process.argv.slice(3), cwd: process.cwd() });
let turns = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const { type, id, message } = JSON.parse(line);
  record({ type, message });
  if (type === "new_session") turns = 0;
  const stats = {
    userMessages: turns,
    assistantMessages: turns * 2,
    tokens: { input: turns * 10, output: turns * 4, total: turns * 14 },
  };
  const data =
    type === "get_session_stats"
      ? stats
      : type === "get_available_thinking_levels"
        ? { levels: ["low"] }
        : {};
  emit({ type: "response", success: true, id, data });
  if (type === "prompt") {
    turns++;
    emit({
      type: "message_end",
      message: { role: "assistant", usage: { totalTokens: 5 } },
    });
    emit({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "call",
      args: { command: "pwd" },
    });
    emit({
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "call",
      result: { content: [{ type: "text", text: "workspace" }] },
      isError: false,
      durationMs: 3,
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Turn " + turns }],
        usage: { totalTokens: 9 },
      },
    });
    emit({ type: "agent_settled" });
  }
}
