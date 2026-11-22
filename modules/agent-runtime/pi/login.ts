import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { piRuntime } from "./launch.mjs";
export async function openLogin() {
  const { node, cli } = piRuntime();
  const script = [
    "on run argv",
    'set loginCmd to quoted form of (item 1 of argv) & " " & quoted form of (item 2 of argv) & " auth login openai"',
    'tell application "Terminal"',
    "activate",
    "do script loginCmd",
    "end tell",
    "end run",
  ];
  await promisify(execFile)("osascript", [
    ...script.flatMap((line) => ["-e", line]),
    node,
    cli,
  ]);
}
