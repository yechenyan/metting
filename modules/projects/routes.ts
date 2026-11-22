import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { json, readObject, unknown, type Route } from "../../shared/http.ts";
import { Projects } from "./repository.ts";
import type { Project } from "./types.ts";
export async function chooseFolder() {
  try {
    const { stdout } = await promisify(execFile)("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "Select a meeting project folder")',
    ]);
    return { folder: stdout.trim() };
  } catch (error) {
    if (String(error).includes("-128")) return { folder: null };
    throw error;
  }
}
export async function projectRoute(
  { req, res, id, action }: Route,
  projects: Projects,
  changed: (project: Project, limitChanged: boolean) => void,
) {
  if (req.method === "POST" && !id)
    return json(res, projects.create(await readObject(req)), 201);
  if (req.method === "POST" && action === "meetings") {
    await readObject(req);
    return json(res, projects.add(id), 201);
  }
  if (req.method === "PATCH" && id && !action) {
    const value = await readObject(req);
    const { folder: previousFolder, maxRecordingMinutes: previousLimit } =
      projects.project(id);
    const project = projects.editProject(
      id,
      value.name,
      value.defaults,
      value.maxRecordingMinutes,
      value.folder,
    );
    const limitChanged = project.maxRecordingMinutes !== previousLimit;
    if (limitChanged || project.folder !== previousFolder)
      changed(project, limitChanged);
    return json(res, project);
  }
  return unknown(res);
}
