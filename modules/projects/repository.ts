import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  defaultSourceLanguage,
  languages,
  type Language,
} from "../speech/types.ts";
import { type Meeting, type Settings } from "../meetings/types.ts";
import { type Project } from "./types.ts";
import {
  defaultMaxRecordingMinutes,
  validRecordingMinutes,
} from "./recording-limit.ts";
import {
  defaultTranslationLanguage,
  translationLanguages,
} from "../transcripts/translation.ts";
export const defaultSettings: Settings = {
  language: defaultSourceLanguage,
  source: "system",
  application: "",
  inputDevice: "",
  inputChannel: 1,
  model: "",
  thinking: "low",
  editing: true,
  translate: true,
  localTranslation: true,
  translationLanguage: defaultTranslationLanguage,
};
export function settings(
  input: Partial<Settings>,
  current = defaultSettings,
): Settings {
  const next = { ...current };
  if (input.translationLanguage !== undefined) {
    if (!translationLanguages.includes(input.translationLanguage))
      throw new Error("Unsupported translation language");
    next.translationLanguage = input.translationLanguage;
  }
  if (languages.includes(input.language as Language))
    next.language = input.language!;
  if (input.source === "system" || input.source === "mic")
    next.source = input.source;
  else if (input.source !== undefined)
    throw new Error("Choose a single audio source");
  if (input.inputDevice !== undefined) {
    if (
      typeof input.inputDevice !== "string" ||
      input.inputDevice.includes("\0")
    )
      throw new Error("Invalid input device ID");
    if (input.inputDevice !== current.inputDevice) next.inputChannel = 1;
    next.inputDevice = input.inputDevice;
  }
  if (input.inputChannel !== undefined) {
    if (!Number.isSafeInteger(input.inputChannel) || input.inputChannel < 1)
      throw new Error("Input channels start at 1");
    next.inputChannel = input.inputChannel;
  }
  for (const key of ["application", "model", "thinking"] as const) {
    if (typeof input[key] === "string")
      next[key] = input[key]!.trim().slice(0, 200);
  }
  for (const key of ["editing", "translate", "localTranslation"] as const)
    if (typeof input[key] === "boolean") next[key] = input[key]!;
  if (input.editing === false && input.translate === undefined)
    next.translate = false;
  return next;
}
type StoredSettings = Omit<Partial<Settings>, "source"> & {
  source?: Settings["source"] | "both";
};
function migrateSettings(old: StoredSettings, base: Settings) {
  return settings(
    { ...old, source: old.source === "both" ? "system" : old.source },
    base,
  );
}
function selectedFolder(value: unknown) {
  if (value === "") return "";
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    !statSync(value, { throwIfNoEntry: false })?.isDirectory()
  )
    throw new Error("Invalid project folder");
  return resolve(value);
}
function makeMeeting(defaults: Settings, storageFolder: string): Meeting {
  return {
    id: randomUUID(),
    created: new Date().toISOString(),
    storageFolder,
    settings: { ...defaults },
  };
}
export function dateName(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join(
      "-",
    ) +
    " " +
    [pad(date.getHours()), pad(date.getMinutes())].join(":")
  );
}
export class Projects {
  private file: string;
  all: Project[];
  constructor(private base: string) {
    mkdirSync(base, { recursive: true });
    this.file = join(base, "projects.json");
    const stored = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8"))
      : { version: 6, projects: [] };
    const legacyArray = Array.isArray(stored);
    if (
      !legacyArray &&
      (![2, 3, 4, 5, 6].includes(stored.version) ||
        !Array.isArray(stored.projects))
    )
      throw new Error("Unsupported project registry");
    this.all = legacyArray ? stored : stored.projects;
    if (legacyArray || stored.version < 4) {
      for (const p of this.all) {
        const defaults = p.defaults || {};
        p.defaults = migrateSettings(
          legacyArray
            ? { ...defaults, translate: defaults.editing !== false }
            : defaults,
          defaultSettings,
        );
        for (const meeting of p.meetings)
          meeting.settings = migrateSettings(
            meeting.settings || {},
            p.defaults,
          );
      }
    }
    let upgraded = legacyArray || stored.version < 6;
    for (const project of this.all) {
      if (!validRecordingMinutes(project.maxRecordingMinutes)) {
        project.maxRecordingMinutes = defaultMaxRecordingMinutes;
        upgraded = true;
      }
      for (const meeting of project.meetings) {
        if (typeof meeting.storageFolder !== "string") {
          meeting.storageFolder = project.folder || "";
          upgraded = true;
        }
      }
    }
    if (upgraded) this.save(this.all);
    if (!this.all.length) this.create({});
  }
  private save(records: Project[]) {
    const temp = this.file + "." + randomUUID() + ".tmp";
    writeFileSync(temp, JSON.stringify({ version: 6, projects: records }), {
      mode: 0o600,
    });
    renameSync(temp, this.file);
  }
  create(input: {
    name?: string;
    folder?: string;
    maxRecordingMinutes?: number;
    defaults?: Partial<Settings>;
  }) {
    const folder = selectedFolder(
      input.folder === undefined ? "" : input.folder,
    );
    const defaults = settings(input.defaults || {});
    const { maxRecordingMinutes = defaultMaxRecordingMinutes } = input;
    if (!validRecordingMinutes(maxRecordingMinutes))
      throw new Error(
        "Recording duration must be a positive whole number of minutes",
      );
    const p: Project = {
      id: randomUUID(),
      name:
        String(input.name || "")
          .trim()
          .slice(0, 100) || dateName(),
      created: new Date().toISOString(),
      folder,
      maxRecordingMinutes,
      defaults,
      meetings: [makeMeeting(defaults, folder)],
    };
    mkdirSync(this.directory(p, p.meetings[0]), { recursive: true });
    const next = [p, ...this.all];
    this.save(next);
    this.all = next;
    return p;
  }
  directory(p: Project, meeting: Meeting) {
    return join(
      meeting.storageFolder
        ? join(meeting.storageFolder, "MeetingDesk")
        : join(this.base, "projects"),
      basename(p.id),
      "meetings",
      basename(meeting.id),
    );
  }
  project(id: string) {
    const p = this.all.find((p) => p.id === id);
    if (!p) throw new Error("Project not found");
    return p;
  }
  chatWorkspace(meetingId: string) {
    const { project } = this.find(meetingId);
    if (project.folder) return project.folder;
    const workspace = join(this.base, "projects", project.id, "workspace");
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    return workspace;
  }
  find(id: string) {
    for (const project of this.all) {
      const meeting = project.meetings.find((m) => m.id === id);
      if (meeting) return { project, meeting };
    }
    throw new Error("Meeting not found");
  }
  add(id: string) {
    const project = this.project(id);
    const meeting = makeMeeting(project.defaults, project.folder);
    mkdirSync(this.directory(project, meeting), { recursive: true });
    const meetings = [meeting, ...project.meetings];
    this.commit(project, { ...project, meetings });
    return meeting;
  }
  private commit(current: Project, next: Project) {
    this.save(this.all.map((p) => (p === current ? next : p)));
    Object.assign(current, next);
  }
  editProject(
    id: string,
    name: string,
    defaults: Partial<Settings>,
    maxRecordingMinutes?: number,
    folder?: string,
  ) {
    const p = this.project(id);
    const limit =
      maxRecordingMinutes === undefined
        ? p.maxRecordingMinutes
        : maxRecordingMinutes;
    if (!validRecordingMinutes(limit))
      throw new Error(
        "Recording duration must be a positive whole number of minutes",
      );
    this.commit(p, {
      ...p,
      folder:
        folder === undefined || folder === p.folder
          ? p.folder
          : selectedFolder(folder),
      name:
        String(name || p.name)
          .trim()
          .slice(0, 100) || p.name,
      defaults: settings(
        { translate: p.defaults.translate, ...defaults },
        p.defaults,
      ),
      maxRecordingMinutes: limit,
    });
    return p;
  }
  configure(meeting: Meeting, values: Partial<Settings>) {
    const { project } = this.find(meeting.id),
      next = settings(
        { translate: meeting.settings.translate, ...values },
        meeting.settings,
      );
    const meetings = project.meetings.map((m) =>
      m === meeting ? { ...m, settings: next } : m,
    );
    this.save(this.all.map((p) => (p === project ? { ...p, meetings } : p)));
    meeting.settings = next;
    return meeting;
  }
}
