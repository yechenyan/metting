import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  defaultSourceLanguage,
  languages,
  type Language,
} from "../speech/types.ts";
import { type Meeting, type Settings } from "../meetings/types.ts";
import { type Project } from "./types.ts";
import { defaultRecordingName, recordingStem } from "../meetings/names.ts";
import { RecordingStorage, emptyPlan, validateComponent } from "./storage.ts";
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
function makeMeeting(
  defaults: Settings,
  storageFolder: string,
  name: string,
): Meeting {
  return {
    id: randomUUID(),
    name,
    directoryName: "",
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
  private storage: RecordingStorage;
  private users = new Map<string, number>();
  private failedRenames = new Set<string>();
  all: Project[];
  constructor(base: string) {
    mkdirSync(base, { recursive: true });
    this.storage = new RecordingStorage(base);
    const stored = existsSync(this.storage.index)
      ? JSON.parse(readFileSync(this.storage.index, "utf8"))
      : { version: 7, projects: [] };
    const legacyArray = Array.isArray(stored);
    if (
      !legacyArray &&
      (![2, 3, 4, 5, 6, 7].includes(stored.version) ||
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
    const migration = emptyPlan();
    let upgraded = legacyArray || stored.version < 7;
    for (const project of this.all) {
      for (const entry of [project, ...project.meetings]) {
        validateComponent(entry.id);
        if (entry.directoryName) validateComponent(entry.directoryName);
        if (entry.pendingDirectoryName)
          validateComponent(entry.pendingDirectoryName);
      }
      if (!validRecordingMinutes(project.maxRecordingMinutes)) {
        project.maxRecordingMinutes = defaultMaxRecordingMinutes;
        upgraded = true;
      }
      for (const [i, meeting] of project.meetings.entries()) {
        if (meeting.projectDirectoryName)
          validateComponent(meeting.projectDirectoryName);
        if (typeof meeting.storageFolder !== "string") {
          meeting.storageFolder = project.folder || "";
          upgraded = true;
        }
        meeting.name ||= defaultRecordingName(project.meetings.length - i);
      }
      if (!project.directoryName) {
        project.directoryName = this.storage.projectName(
          project.name,
          this.all,
          project.meetings.map((m) => m.storageFolder),
          project,
        );
        upgraded = true;
      }
      for (const meeting of project.meetings) {
        if (!meeting.directoryName) {
          meeting.directoryName = this.storage.meetingName(
            meeting.name,
            project,
            meeting.storageFolder,
            meeting,
          );
          upgraded = true;
        }
      }
      const pending =
        legacyArray || stored.version < 7
          ? [...new Set(["", ...project.meetings.map((m) => m.storageFolder)])]
          : project.legacyFolders || [];
      const available = pending.filter(
        (folder) => !folder || existsSync(folder),
      );
      if (available.length) {
        for (const folder of available.filter((f) =>
          project.legacyFolders?.includes(f),
        )) {
          const parent = this.storage.freeParentName(
            project.directoryName,
            folder,
          );
          for (const m of project.meetings.filter(
            (m) => m.storageFolder === folder,
          ))
            m.projectDirectoryName =
              parent === project.directoryName ? undefined : parent;
        }
        this.storage.migrate(project, migration, available);
        upgraded = true;
      }
      const offline = pending.filter((folder) => !available.includes(folder));
      if (offline.length) project.legacyFolders = offline;
      else delete project.legacyFolders;
    }
    if (upgraded || migration.moves.length)
      this.storage.save(this.all, migration);
    for (const project of this.all)
      if (
        project.meetings.every(
          (m) => !m.storageFolder || existsSync(m.storageFolder),
        )
      )
        this.finishPending(project);
    if (!this.all.length) this.create({});
  }
  get defaultRoot() {
    return this.storage.root("");
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
    const name =
      String(input.name || "")
        .trim()
        .slice(0, 100) || dateName();
    const p: Project = {
      id: randomUUID(),
      name,
      directoryName: this.storage.projectName(name, this.all, [folder]),
      created: new Date().toISOString(),
      folder,
      maxRecordingMinutes,
      defaults,
      meetings: [],
    };
    const first = makeMeeting(defaults, folder, defaultRecordingName(1));
    first.directoryName = this.storage.meetingName(first.name, p, folder);
    p.meetings.push(first);
    const next = [p, ...this.all];
    this.storage.save(next, {
      moves: [],
      directories: [this.directory(p, first)],
    });
    this.all = next;
    return p;
  }
  directory(p: Project, meeting: Meeting) {
    this.ensureFolder(p, meeting.storageFolder);
    if (!this.users.has(p.id)) this.finishPending(p);
    return this.storage.directory(p, meeting);
  }
  private ensureFolder(p: Project, folder: string) {
    if (folder && !existsSync(folder))
      throw new Error("Recording folder is offline");
    if (p.legacyFolders?.includes(folder)) {
      const plan = emptyPlan();
      const remaining = p.legacyFolders.filter((f) => f !== folder);
      const parent = this.storage.freeParentName(p.directoryName, folder);
      const projectDirectoryName =
        parent === p.directoryName ? undefined : parent;
      const next = {
        ...p,
        legacyFolders: remaining.length ? remaining : undefined,
        meetings: p.meetings.map((m) =>
          m.storageFolder === folder ? { ...m, projectDirectoryName } : m,
        ),
      };
      this.storage.migrate(next, plan, [folder]);
      this.storage.save(
        this.all.map((project) => (project === p ? next : project)),
        plan,
      );
      for (const m of p.meetings)
        if (m.storageFolder === folder)
          m.projectDirectoryName = projectDirectoryName;
      p.legacyFolders = next.legacyFolders;
    }
  }
  stem(p: Project, meeting: Meeting) {
    return recordingStem(
      meeting.projectDirectoryName ?? p.directoryName,
      meeting.directoryName,
    );
  }
  stateDirectory(p: Project, meeting: Meeting) {
    this.ensureFolder(p, meeting.storageFolder);
    const dir = this.storage.state(p, meeting);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  hold(project: Project) {
    this.users.set(project.id, (this.users.get(project.id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.users.get(project.id)! - 1;
      if (count) this.users.set(project.id, count);
      else {
        this.users.delete(project.id);
        this.finishPending(project, true);
      }
    };
  }
  private finishPending(project: Project, reportError = false) {
    if (
      !this.failedRenames.has(project.id) &&
      (project.pendingDirectoryName ||
        project.meetings.some((m) => m.pendingDirectoryName)) &&
      project.meetings.every(
        (m) => !m.storageFolder || existsSync(m.storageFolder),
      )
    ) {
      try {
        for (const folder of project.legacyFolders || [])
          this.ensureFolder(project, folder);
        this.commit(project, project);
      } catch (error) {
        // Keep using the original files if a deferred rename encounters a conflict.
        this.failedRenames.add(project.id);
        if (reportError) throw error;
      }
    }
  }
  project(id: string) {
    const p = this.all.find((p) => p.id === id);
    if (!p) throw new Error("Project not found");
    return p;
  }
  chatWorkspace(meetingId: string) {
    const { project } = this.find(meetingId);
    if (project.folder) return project.folder;
    const workspace = this.storage.workspace(project);
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
  add(id: string, name?: string) {
    const project = this.project(id);
    this.ensureFolder(project, project.folder);
    const meeting = makeMeeting(
      project.defaults,
      project.folder,
      name === undefined
        ? defaultRecordingName(project.meetings.length + 1)
        : this.recordingName(name),
    );
    const parent = this.storage.parentName(project, project.folder);
    if (parent !== project.directoryName) meeting.projectDirectoryName = parent;
    meeting.directoryName = this.storage.meetingName(
      meeting.name,
      project,
      project.folder,
    );
    const meetings = [meeting, ...project.meetings];
    this.commit(project, { ...project, meetings }, meeting);
    return meeting;
  }
  private commit(current: Project, next: Project, created?: Meeting) {
    let plan = emptyPlan();
    if (
      !this.users.has(current.id) &&
      (next.pendingDirectoryName ||
        next.meetings.some((m) => m.pendingDirectoryName)) &&
      !current.legacyFolders?.length &&
      next.meetings.every(
        (m) => !m.storageFolder || existsSync(m.storageFolder),
      )
    ) {
      const renamedProject = Boolean(next.pendingDirectoryName);
      next = {
        ...next,
        directoryName: next.pendingDirectoryName || next.directoryName,
        pendingDirectoryName: undefined,
        meetings: next.meetings.map((m) => ({
          ...m,
          directoryName: m.pendingDirectoryName || m.directoryName,
          pendingDirectoryName: undefined,
          projectDirectoryName: renamedProject
            ? undefined
            : m.projectDirectoryName,
        })),
      };
      plan = this.storage.rename(current, next);
    }
    if (created)
      plan.directories.push(
        this.storage.directory(
          next,
          next.meetings.find((m) => m.id === created.id)!,
        ),
      );
    this.storage.save(
      this.all.map((p) => (p === current ? next : p)),
      plan,
    );
    const existing = new Map(current.meetings.map((m) => [m.id, m]));
    const meetings = next.meetings.map((m) =>
      existing.has(m.id) ? Object.assign(existing.get(m.id)!, m) : m,
    );
    Object.assign(current, next, { meetings });
    this.failedRenames.delete(current.id);
  }
  private recordingName(value: unknown) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 100)
      throw new Error("A recording name of 1 to 100 characters is required");
    return value.trim();
  }
  renameRecording(projectId: string, id: string, value: unknown) {
    const { project, meeting } = this.find(id);
    if (project.id !== projectId)
      throw new Error("Recording not found in project");
    const name = this.recordingName(value);
    if (name !== meeting.name || meeting.pendingDirectoryName) {
      const directoryName = this.storage.meetingName(
        name,
        project,
        meeting.storageFolder,
        meeting,
      );
      this.commit(project, {
        ...project,
        meetings: project.meetings.map((m) =>
          m !== meeting
            ? m
            : {
                ...m,
                name,
                pendingDirectoryName:
                  directoryName !== m.directoryName ? directoryName : undefined,
              },
        ),
      });
    }
    return meeting;
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
    const projectName =
      String(name || p.name)
        .trim()
        .slice(0, 100) || p.name;
    const linked =
      folder === undefined || folder === p.folder
        ? p.folder
        : selectedFolder(folder);
    const directoryName =
      projectName === p.name
        ? p.pendingDirectoryName || p.directoryName
        : this.storage.projectName(
            projectName,
            this.all,
            [linked, ...p.meetings.map((m) => m.storageFolder)],
            p,
          );
    this.commit(p, {
      ...p,
      folder: linked,
      name: projectName,
      pendingDirectoryName:
        directoryName === p.directoryName ? undefined : directoryName,
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
    this.storage.save(
      this.all.map((p) => (p === project ? { ...p, meetings } : p)),
    );
    meeting.settings = next;
    return meeting;
  }
}
