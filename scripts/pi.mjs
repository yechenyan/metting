import { spawnSync } from "node:child_process";
import {
  piRuntime,
  subscriptionEnv,
} from "../modules/agent-runtime/pi/launch.mjs";
const { node, cli } = piRuntime();
const child = spawnSync(node, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: subscriptionEnv(),
});
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
