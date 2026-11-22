import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
let resolved;
export function piRuntime() {
  if (resolved) return resolved;
  const cli = join(
    dirname(
      fileURLToPath(
        import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
      ),
    ),
    "cli.js",
  );
  const dirs = (process.env.PATH || "").split(delimiter);
  const candidates = new Set([
    process.env.MEETING_DESK_NODE,
    process.execPath,
    ...dirs.map((p) => join(p, "node")),
  ]);
  for (const node of candidates) {
    if (!node || !existsSync(node)) continue;
    const version = spawnSync(node, ["-p", "process.versions.node"], {
      encoding: "utf8",
      timeout: 2000,
    }).stdout;
    const [major, minor] = String(version).split(".").map(Number);
    if (major > 22 || (major === 22 && minor >= 19))
      return (resolved = { node, cli });
  }
  throw new Error(
    "Pi requires Node 22.19 or later. Install a supported Node runtime or set MEETING_DESK_NODE.",
  );
}
export function subscriptionEnv() {
  const env = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
    "ANTHROPIC_API_KEY",
  ])
    delete env[key];
  return env;
}
