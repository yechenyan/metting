import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cacheDir, root } from "../shared/paths.mjs";

const installers = {
  speech: ["modules/speech/recognition/download.py", "models"],
  translation: ["modules/local-translation/model_store.py", "translation"],
};
const args = process.argv.slice(2);
const [group = "all"] = args;
const usage = "Usage: npm run models:download -- [all|speech|translation]";
if (args.length === 1 && ["-h", "--help"].includes(group)) {
  console.log(usage);
  process.exit(0);
}
if (args.length > 1 || (group !== "all" && !Object.hasOwn(installers, group))) {
  console.error(usage);
  process.exit(2);
}

const managedPython = join(cacheDir, "runtime", "bin", "python");
const python =
  process.env.MEETING_DESK_PYTHON ||
  (existsSync(managedPython) ? managedPython : undefined);
const prefix = python
  ? []
  : ["run", "--no-project", "--python", "3.12", "--", "python"];
const selected =
  group === "all" ? Object.values(installers) : [installers[group]];
for (const [script, directory] of selected) {
  const destination = join(cacheDir, directory);
  console.log("Model cache:", destination);
  const result = spawnSync(
    python || "uv",
    [...prefix, join(root, script), destination],
    {
      stdio: "inherit",
    },
  );
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
