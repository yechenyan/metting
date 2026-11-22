import { useEffect, useState, type FormEvent, type Ref } from "react";
import {
  Plus,
  Folder,
  FolderOpen,
  ListFilter,
  X,
  PlugZap,
  ChevronRight,
  ChevronDown,
  FileAudio,
  Check,
  LoaderCircle,
  PanelLeftClose,
} from "lucide-react";
import { t, api, recordingName } from "../../apps/web/lib";
import { Modal } from "../../apps/web/Modal";
import {
  defaultSourceLanguage,
  languages,
  type Language,
} from "../speech/types.ts";
import type { AgentInfo } from "../agent-runtime/types.ts";
import type { Project } from "./types.ts";
import {
  defaultMaxRecordingMinutes,
  validRecordingMinutes,
} from "./recording-limit";
import { TranslationSelect } from "../transcripts/TranslationSelect";
import {
  defaultTranslationLanguage,
  translationSettings,
  translationTarget,
  type TranslationTarget,
} from "../transcripts/translation";

function ProjectRecordings({
  project,
  selected,
  active,
  choose,
  add,
  adding,
}: {
  project: Project;
  selected?: string;
  active: string | null;
  choose: (id: string) => void;
  add: (id: string) => void;
  adding: boolean;
}) {
  const [expanded, setExpanded] = useState(Boolean(selected));
  useEffect(() => {
    if (selected) setExpanded(true);
  }, [selected]);
  const listId = "recordings-" + project.id;
  const addLabel = t.addRecordingTo.replace("{project}", project.name);
  return (
    <li>
      <div className="project-row">
        <button
          className="project-item"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded(!expanded)}
          title={project.name}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
          <span className="project-label">{project.name}</span>
        </button>
        <button
          className="add-recording"
          disabled={adding}
          onClick={() => add(project.id)}
          aria-label={addLabel}
          title={addLabel}
        >
          <Plus size={14} />
        </button>
      </div>
      <ul
        id={listId}
        className="recordings"
        aria-label={project.name}
        hidden={!expanded}
      >
        {expanded &&
          project.meetings.map((m, i) => (
            <li key={m.id}>
              <button
                className="recording-item"
                aria-current={m.id === selected ? "page" : undefined}
                onClick={() => choose(m.id)}
              >
                <FileAudio size={13} />
                {recordingName(project.meetings.length - i)}
                {m.id === active && (
                  <span
                    className="recording-dot"
                    role="img"
                    aria-label={t.runStates.recording}
                  />
                )}
              </button>
            </li>
          ))}
      </ul>
    </li>
  );
}

export function Sidebar({
  projects,
  current,
  selected,
  active,
  choose,
  create,
  add,
  adding,
  pi,
  connect,
  open,
  mobile,
  closeRef,
  close,
}: {
  projects: Project[];
  current: string;
  selected: string;
  active: string | null;
  choose: (id: string) => void;
  create: () => void;
  add: (projectId: string) => void;
  adding: boolean;
  pi: AgentInfo | null;
  connect: () => void;
  open: boolean;
  mobile: boolean;
  closeRef: Ref<HTMLButtonElement>;
  close: () => void;
}) {
  const [search, setSearch] = useState<string | null>(null);
  const filtered = projects.filter((p) =>
    p.name.toLowerCase().includes((search || "").toLowerCase()),
  );
  return (
    <>
      {mobile && (
        <button
          className="scrim"
          aria-label={t.closePanel}
          tabIndex={-1}
          onClick={close}
        />
      )}
      <aside
        className="sidebar"
        id="projects-panel"
        aria-label={t.projects}
        hidden={!open}
        role={mobile ? "dialog" : undefined}
        aria-modal={mobile || undefined}
        onKeyDown={(e) => {
          if (mobile && e.key === "Escape") close();
        }}
      >
        <div className="side-section">
          <h2>{t.projects}</h2>
          <button
            title={t.searchProjects}
            aria-label={t.searchProjects}
            onClick={() => setSearch(search === null ? "" : null)}
          >
            {search === null ? <ListFilter size={16} /> : <X size={15} />}
          </button>
          <button
            className="new-project-action"
            onClick={create}
            title={t.newProject}
            aria-label={t.newProject}
          >
            <Plus size={16} />
          </button>
          <button
            className="mobile-close icon-btn"
            ref={closeRef}
            onClick={close}
            aria-label={t.closePanel}
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
        {search !== null && (
          <input
            className="side-search"
            aria-label={t.searchProjects}
            autoFocus
            value={search}
            placeholder={t.searchProjects}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        <nav className="project-list" aria-label={t.projects}>
          <ul className="project-tree">
            {filtered.map((p) => (
              <ProjectRecordings
                key={p.id}
                project={p}
                selected={p.id === current ? selected : undefined}
                active={active}
                choose={choose}
                add={add}
                adding={adding}
              />
            ))}
          </ul>
          {!filtered.length && <p>{t.noProjects}</p>}
        </nav>
        <div className="sidebar-bottom">
          <button className="connection-link" onClick={connect}>
            <PlugZap size={18} />
            <span>{t.pi}</span>
            <i className={pi?.ready ? "lit" : ""} />
            <ChevronRight size={15} />
          </button>
        </div>
      </aside>
    </>
  );
}
function defaultName() {
  const d = new Date(),
    pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}
export function ProjectForm({
  project,
  pi,
  close,
  saved,
}: {
  project?: Project;
  pi: AgentInfo | null;
  close: () => void;
  saved: (p: Project) => void;
}) {
  const [name, setName] = useState(project?.name || defaultName()),
    [folder, setFolder] = useState(project?.folder || "");
  const [originalFolder] = useState(folder);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [language, setLanguage] = useState<Language>(
      project?.defaults.language ?? defaultSourceLanguage,
    ),
    [model, setModel] = useState(project?.defaults.model || "");
  const [target, setTarget] = useState<TranslationTarget>(
    project ? translationTarget(project.defaults) : defaultTranslationLanguage,
  );
  const limit = project?.maxRecordingMinutes ?? defaultMaxRecordingMinutes;
  const [hours, setHours] = useState(String(Math.floor(limit / 60)));
  const [minutes, setMinutes] = useState(String(limit % 60));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    const maxRecordingMinutes = Number(hours) * 60 + Number(minutes);
    if (!validRecordingMinutes(maxRecordingMinutes)) {
      setError(t.invalidRecordingLimit);
      return;
    }
    setBusy(true);
    try {
      const p = await api<Project>(
        project ? "projects/" + project.id : "projects",
        {
          name,
          ...(!project || folder !== originalFolder ? { folder } : {}),
          maxRecordingMinutes,
          defaults: { language, model, ...translationSettings(target) },
        },
        project ? "PATCH" : "POST",
      );
      saved(p);
    } catch (e) {
      setError(
        e instanceof Error && e.message === "Invalid project folder"
          ? t.invalidProjectFolder
          : String(e),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={project ? t.projectSettings : t.newProject} close={close}>
      <form onSubmit={submit} className="form">
        {!project && <p className="muted">{t.createHint}</p>}
        <label>
          {t.projectName}
          <input
            autoFocus
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <div className="language-fields">
          <label>
            {t.defaultLanguage}
            <select
              aria-label={t.defaultLanguage}
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
            >
              {languages.map((key) => (
                <option key={key} value={key}>
                  {t.langNames[key]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t.defaultTranslation}
            <TranslationSelect
              label={t.defaultTranslation}
              value={target}
              change={setTarget}
            />
          </label>
        </div>
        <fieldset
          className="recording-limit"
          aria-describedby="recording-limit-hint"
        >
          <legend>{t.maxRecordingDuration}</legend>
          <div>
            <label>
              <input
                type="number"
                inputMode="numeric"
                min="0"
                step="1"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
              {t.hours}
            </label>
            <label>
              <input
                type="number"
                inputMode="numeric"
                min={Number(hours) > 0 ? 0 : 1}
                max="59"
                step="1"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
              {t.minutes}
            </label>
          </div>
          <small id="recording-limit-hint">{t.recordingLimitHint}</small>
        </fieldset>
        <div className="project-folder-field">
          <label htmlFor="project-folder">{t.projectFolder}</label>
          <div>
            <button
              id="project-folder"
              type="button"
              className="field-button"
              disabled={busy || choosingFolder}
              title={folder || t.choose}
              onClick={async () => {
                setChoosingFolder(true);
                try {
                  const r = await api<{ folder: string | null }>("folder", {});
                  if (r.folder) setFolder(r.folder);
                } catch (e) {
                  setError(String(e));
                } finally {
                  setChoosingFolder(false);
                }
              }}
            >
              {choosingFolder ? (
                <LoaderCircle size={16} className="spin" />
              ) : (
                <FolderOpen size={16} />
              )}
              <span>{folder || t.folderPlaceholder}</span>
            </button>
            {folder && (
              <button
                type="button"
                className="icon-btn"
                disabled={busy || choosingFolder}
                aria-label={t.unlinkFolder}
                title={t.unlinkFolder}
                onClick={() => setFolder("")}
              >
                <X size={15} />
              </button>
            )}
          </div>
          <small>{t.projectFolderHint}</small>
        </div>
        <label>
          {t.defaultModel}
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{t.autoModel}</option>
            {pi?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        {!pi?.ready && <small className="muted">{t.defaultModelHint}</small>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <footer>
          <button className="button" type="button" onClick={close}>
            {t.cancel}
          </button>
          <button className="button primary" disabled={busy || choosingFolder}>
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Check size={15} />
            )}{" "}
            {project ? t.save : t.create}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
