import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { cacheDir, root } from "../shared/paths.mjs";
function run(bin, args) {
  const result = spawnSync(bin, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(process.execPath, [join(root, "scripts/build-capture.mjs")]);
const env = join(cacheDir, "runtime"),
  python = join(env, "bin", "python");
run("uv", ["venv", "--allow-existing", "--python", "3.12", env]);
run("uv", [
  "pip",
  "install",
  "--python",
  python,
  "-r",
  join(root, "modules/speech/requirements.txt"),
  "-r",
  join(root, "modules/local-translation/requirements.txt"),
]);
run(python, [
  join(root, "modules/speech/recognition/download.py"),
  join(cacheDir, "models"),
]);
