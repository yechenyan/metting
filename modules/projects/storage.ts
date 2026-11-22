import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { recordingStem } from "../meetings/names.ts";
import type { Meeting } from "../meetings/types.ts";
import { audioFilename, parseAudioFilename } from "../audio/filenames.ts";
import type { Project } from "./types.ts";

function key(name: string) {
  return name.normalize("NFC").toLowerCase();
}
export function diskName(name: string) {
  const clean = name
    .normalize("NFC")
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, "-")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
  let value = "";
  for (const char of clean) {
    if (Buffer.byteLength(value + char) > 80) break;
    value += char;
  }
  return value.trimEnd() || "Untitled";
}
const info = (path: string) => lstatSync(path, { throwIfNoEntry: false });
const entries = (path: string) => (existsSync(path) ? readdirSync(path) : []);
export function validateComponent(name: string) {
  if (
    typeof name !== "string" ||
    !name ||
    name === "." ||
    name === ".." ||
    /[/\\\x00]/.test(name)
  )
    throw new Error("Invalid storage path component");
}

function availableName(name: string, reserved: string[]) {
  const occupied = new Set(reserved.map(key));
  const base = diskName(name);
  let candidate = base;
  for (let n = 2; occupied.has(key(candidate)); n++)
    candidate = base + " (" + n + ")";
  return candidate;
}

interface Move {
  from: string;
  to: string;
  dev: number;
  ino: number;
}
export interface StoragePlan {
  moves: Move[];
  directories: string[];
}
export const emptyPlan = (): StoragePlan => ({ moves: [], directories: [] });
function move(plan: StoragePlan, from: string, to: string, original = from) {
  if (from === to) return;
  const file = info(original);
  if (file) plan.moves.push({ from, to, dev: file.dev, ino: file.ino });
}
function matches(file: ReturnType<typeof info>, step: Move) {
  return file?.dev === step.dev && file.ino === step.ino;
}
function relocate(step: Move) {
  const from = info(step.from),
    to = info(step.to);
  if (to && !matches(to, step))
    throw new Error("Storage destination already exists: " + step.to);
  if (!from && matches(to, step)) return;
  if (!matches(from, step))
    throw new Error("Storage source changed: " + step.from);
  mkdirSync(dirname(step.to), { recursive: true, mode: 0o700 });
  renameSync(step.from, step.to);
}
function atomicJson(path: string, value: unknown) {
  const tmp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export class RecordingStorage {
  readonly index: string;
  private pending: string;
  constructor(private base: string) {
    this.index = join(base, "projects.json");
    this.pending = join(base, ".recording-layout.json");
    if (existsSync(this.pending)) {
      const { plan, registry } = JSON.parse(readFileSync(this.pending, "utf8"));
      this.finish(plan, registry);
    }
  }
  root(folder: string) {
    return folder ? join(folder, "MeetingDesk") : join(this.base, "projects");
  }
  freeParentName(name: string, folder: string) {
    return availableName(name, entries(this.root(folder)));
  }
  directory(project: Project, meeting: Meeting) {
    return join(
      this.root(meeting.storageFolder),
      meeting.projectDirectoryName ?? project.directoryName,
      meeting.directoryName,
    );
  }
  parentName(project: Project, folder: string) {
    const existing = project.meetings.find((m) => m.storageFolder === folder);
    return existing
      ? (existing.projectDirectoryName ?? project.directoryName)
      : this.freeParentName(project.directoryName, folder);
  }
  state(project: Project, meeting: Meeting) {
    return join(
      this.root(meeting.storageFolder),
      ".meetingdesk",
      project.id,
      "meetings",
      meeting.id,
    );
  }
  workspace(project: Project) {
    return join(this.root(""), ".meetingdesk", project.id, "workspace");
  }
  projectName(
    name: string,
    others: Project[],
    folders: string[],
    current?: Project,
  ) {
    const reserved = others
      .filter((p) => p.id !== current?.id)
      .flatMap((p) => [
        p.directoryName,
        p.pendingDirectoryName || p.directoryName,
      ])
      .filter(Boolean);
    for (const folder of new Set(folders)) {
      const own = current?.meetings.find((m) => m.storageFolder === folder);
      const currentName =
        own && (own.projectDirectoryName ?? current?.directoryName);
      reserved.push(
        ...entries(this.root(folder)).filter(
          (entry) => !currentName || key(entry) !== key(currentName),
        ),
      );
    }
    return availableName(name, reserved);
  }
  meetingName(
    name: string,
    project: Project,
    folder: string,
    current?: Meeting,
  ) {
    const others = project.meetings.filter((m) => m.id !== current?.id);
    const reserved = others
      .flatMap((m) => [
        m.directoryName,
        m.pendingDirectoryName || m.directoryName,
      ])
      .filter(Boolean);
    reserved.push(
      ...entries(
        join(this.root(folder), this.parentName(project, folder)),
      ).filter(
        (entry) =>
          !current?.directoryName || key(entry) !== key(current.directoryName),
      ),
    );
    return availableName(name, reserved);
  }
  save(projects: Project[], plan: StoragePlan = emptyPlan()) {
    const registry = { version: 7, projects };
    if (existsSync(this.pending))
      throw new Error("A recording storage update needs recovery");
    if (!plan.moves.length && !plan.directories.length)
      return atomicJson(this.index, registry);
    atomicJson(this.pending, { plan, registry });
    this.finish(plan, registry);
  }
  private finish(plan: StoragePlan, registry: object) {
    const done: Move[] = [];
    try {
      for (const step of plan.moves) {
        relocate(step);
        done.push(step);
      }
      for (const directory of plan.directories)
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      atomicJson(this.index, registry);
    } catch (error) {
      for (const step of done.reverse())
        relocate({ ...step, from: step.to, to: step.from });
      unlinkSync(this.pending);
      throw error;
    }
    unlinkSync(this.pending);
  }
  private files(
    plan: StoragePlan,
    original: string,
    from: string,
    to: string,
    oldStem: string,
    stem: string,
  ) {
    for (const ext of [".jsonl", ".md"])
      move(
        plan,
        join(from, oldStem + ext),
        join(to, stem + ext),
        join(original, oldStem + ext),
      );
    const audio = info(join(original, "audio"));
    if (!audio) return;
    if (!audio.isDirectory())
      throw new Error("The recording audio folder must be a directory");
    const taken = new Set(
      [...entries(join(to, "audio")), ...entries(join(original, "audio"))].map(
        key,
      ),
    );
    for (const file of entries(join(original, "audio")).sort()) {
      const part = parseAudioFilename(file);
      if (
        !part ||
        (part.stem && key(part.stem) !== key(oldStem)) ||
        !info(join(original, "audio", file))?.isFile()
      )
        continue;
      const source = join(from, "audio", file);
      let n = part.copy,
        name = audioFilename(stem, part.start, n);
      while (taken.has(key(name)) && key(name) !== key(file))
        name = audioFilename(stem, part.start, ++n);
      taken.add(key(name));
      move(
        plan,
        source,
        join(to, "audio", name),
        join(original, "audio", file),
      );
    }
  }
  migrate(project: Project, plan: StoragePlan, folders: string[]) {
    for (const folder of new Set(folders)) {
      const root = this.root(folder),
        old = join(root, project.id),
        state = join(root, ".meetingdesk", project.id);
      if (
        !info(old)?.isDirectory() ||
        (!existsSync(join(old, "meetings")) &&
          !existsSync(join(old, "workspace")))
      )
        continue;
      move(plan, old, state);
      for (const meeting of project.meetings.filter(
        (m) => m.storageFolder === folder,
      )) {
        const before = join(old, "meetings", meeting.id);
        if (!info(before)?.isDirectory()) continue;
        const to = this.directory(project, meeting);
        plan.directories.push(to);
        this.files(
          plan,
          before,
          this.state(project, meeting),
          to,
          "transcript",
          recordingStem(
            meeting.projectDirectoryName ?? project.directoryName,
            meeting.directoryName,
          ),
        );
      }
    }
  }
  rename(project: Project, next: Project) {
    const plan = emptyPlan();
    const renamedProject = next.directoryName !== project.directoryName;
    for (const folder of new Set(
      project.meetings.map((m) => m.storageFolder),
    )) {
      const root = this.root(folder);
      if (renamedProject)
        move(
          plan,
          join(root, this.parentName(project, folder)),
          join(root, next.directoryName),
        );
    }
    for (const old of project.meetings) {
      const meeting = next.meetings.find((m) => m.id === old.id)!;
      if (!renamedProject && old.directoryName === meeting.directoryName)
        continue;
      if (old.storageFolder && !existsSync(old.storageFolder))
        throw new Error("Recording folder is offline");
      const original = this.directory(project, old),
        to = this.directory(next, meeting),
        from = join(dirname(to), old.directoryName);
      move(plan, from, to, original);
      this.files(
        plan,
        original,
        to,
        to,
        recordingStem(
          old.projectDirectoryName ?? project.directoryName,
          old.directoryName,
        ),
        recordingStem(
          meeting.projectDirectoryName ?? next.directoryName,
          meeting.directoryName,
        ),
      );
    }
    return plan;
  }
}
