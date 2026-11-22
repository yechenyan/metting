import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronRight,
  CircleAlert,
  Download,
  Ellipsis,
  FolderOpen,
  MessagesSquare,
  PanelLeftOpen,
  Pencil,
  Plus,
  Settings2,
} from "lucide-react";
import { WorkspacePanes } from "./WorkspacePanes";
import { Sidebar } from "../../modules/projects/ui";
import { Controls } from "../../modules/meetings/Controls";
import { RenameRecording } from "../../modules/meetings/RenameRecording";
import { MeetingNotice } from "../../modules/meetings/Notice";
import { Timeline } from "../../modules/transcripts/Timeline";
import { translationTarget } from "../../modules/transcripts/translation";
import { TranscriptClient, usePart } from "../../modules/transcripts/client";
import type { Project } from "../../modules/projects/types";
import { millisecondsPerMinute } from "../../modules/projects/recording-limit";
import type { Meeting, Settings } from "../../modules/meetings/types";
import { api, t, type Runtime } from "./lib";
import { ChatWorkspace } from "../../modules/chat/Workspace";
import {
  releaseQuotation,
  type CaptionQuotation,
} from "../../modules/transcripts/quotation";

const dockedChat = window.matchMedia("(min-width: 980px)");
const chatPreference = "meeting.desk.chat.visible";

export function Desk({
  chatUrl,
  project,
  meeting,
  projects,
  activeId,
  runtime,
  createProject,
  editProject,
  createMeeting,
  addingRecording,
  changeMeeting,
  reload,
  refresh,
  login,
  change,
  sidebarOpen,
  mobileDrawer,
  setSidebar,
  error,
}: {
  chatUrl: string;
  project: Project;
  meeting: Meeting;
  projects: Project[];
  activeId: string | null;
  runtime: Runtime | null;
  createProject: () => void;
  editProject: () => void;
  createMeeting: (projectId: string) => void;
  addingRecording: boolean;
  changeMeeting: (id: string) => void;
  reload: () => void;
  refresh: () => void;
  login: () => void;
  change: (v: Partial<Settings>) => Promise<void>;
  sidebarOpen: boolean;
  mobileDrawer: boolean;
  setSidebar: (v: boolean) => void;
  error: (s: string) => void;
}) {
  const client = useMemo(() => new TranscriptClient(meeting.id), [meeting.id]);
  const [renaming, setRenaming] = useState<{
    projectId: string;
    meeting: Meeting;
  } | null>(null);
  const [quotation, setQuotation] = useState<CaptionQuotation | null>(null);
  const clearQuotation = useCallback((quote: CaptionQuotation) => {
    releaseQuotation(quote);
    setQuotation((current) => (current === quote ? null : current));
  }, []);
  const [replyWaiting, setReplyWaiting] = useState(false);
  const [compactChat, setCompactChat] = useState(!dockedChat.matches);
  const [chatOpen, setChatOpen] = useState(
    () =>
      dockedChat.matches && localStorage.getItem(chatPreference) !== "closed",
  );
  const chatToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const resize = () => {
      setCompactChat(!dockedChat.matches);
      const open =
        dockedChat.matches && localStorage.getItem(chatPreference) !== "closed";
      setChatOpen(open);
      if (open) setReplyWaiting(false);
    };
    dockedChat.addEventListener("change", resize);
    return () => dockedChat.removeEventListener("change", resize);
  }, []);
  function showChat(open: boolean) {
    setChatOpen(open);
    if (open) setReplyWaiting(false);
    if (dockedChat.matches)
      localStorage.setItem(chatPreference, open ? "open" : "closed");
    if (!open) requestAnimationFrame(() => chatToggle.current?.focus());
  }
  useEffect(() => client.open(), [client]);
  const state = usePart(client, "state", () => client.state);
  const active = ["preparing", "recording", "stopping"].includes(state.value);
  const prior = useRef(false);
  useEffect(() => {
    if (prior.current !== active) {
      prior.current = active;
      reload();
    }
  }, [active, reload]);

  const actions = useRef<HTMLDivElement>(null);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const projectClose = useRef<HTMLButtonElement>(null);
  const projectFocusPending = useRef(false);
  const projectsDocked = sidebarOpen && !mobileDrawer;
  function showProjects(open: boolean) {
    projectFocusPending.current = true;
    setSidebar(open);
  }
  useLayoutEffect(() => {
    if (projectFocusPending.current || mobileDrawer) {
      const target = sidebarOpen ? projectClose : sidebarToggle;
      target.current?.focus({ preventScroll: true });
    }
    // Selecting a recording can also dismiss the mobile drawer.
    projectFocusPending.current = mobileDrawer;
  }, [sidebarOpen, mobileDrawer]);

  const notice = state.notice;
  const relevantNotice =
    notice &&
    !(
      notice.code === "recordingLimitReached" &&
      state.elapsed < project.maxRecordingMinutes * millisecondsPerMinute
    ) &&
    !(
      notice.code === "systemAudioPermission" &&
      meeting.settings.source === "mic"
    ) &&
    !(
      notice.code === "microphonePermission" &&
      meeting.settings.source === "system"
    );

  return (
    <div className="app-shell">
      <WorkspacePanes
        projectsDocked={projectsDocked}
        chatDocked={chatOpen && !compactChat}
        projects={
          <Sidebar
            projects={projects}
            current={project.id}
            selected={meeting.id}
            active={activeId}
            choose={changeMeeting}
            create={createProject}
            add={createMeeting}
            rename={(projectId, meeting) => setRenaming({ projectId, meeting })}
            adding={addingRecording}
            pi={runtime?.pi || null}
            connect={login}
            open={sidebarOpen}
            mobile={mobileDrawer}
            closeRef={projectClose}
            close={() => showProjects(false)}
          />
        }
        chat={
          <ChatWorkspace
            key={meeting.id}
            meeting={meeting}
            projectFolder={project.folder}
            editProject={editProject}
            endpoint={chatUrl}
            pi={runtime?.pi ?? null}
            login={login}
            compact={compactChat}
            open={chatOpen}
            setOpen={showChat}
            quotation={quotation}
            clearQuotation={clearQuotation}
            revealReply={() => {
              if (dockedChat.matches) showChat(true);
              else setReplyWaiting(true);
            }}
          />
        }
      >
        <main className="main" inert={mobileDrawer}>
          <header className="pane-heading desk-nav" aria-label={t.meetings}>
            {!projectsDocked && (
              <button
                className="icon-btn sidebar-toggle"
                ref={sidebarToggle}
                aria-label={t.openProjects}
                title={t.openProjects}
                aria-controls="projects-panel"
                aria-expanded={sidebarOpen}
                onClick={() => showProjects(true)}
              >
                <PanelLeftOpen size={17} />
              </button>
            )}
            <div className="desk-path">
              <h1 title={project.name}>{project.name}</h1>
              <ChevronRight size={12} className="path-separator" />
              <select
                aria-label={t.changeMeeting}
                title={meeting.name}
                value={meeting.id}
                onChange={(e) => changeMeeting(e.target.value)}
              >
                {project.meetings.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <Controls
              client={client}
              meeting={meeting}
              maxRecordingMinutes={project.maxRecordingMinutes}
              pi={runtime?.pi || null}
              activeOther={!!activeId && activeId !== meeting.id}
              change={change}
              onActive={reload}
              error={error}
              login={login}
            />
            <button
              className="icon-btn"
              popoverTarget="session-actions"
              onClick={(e) => {
                const button = e.currentTarget.getBoundingClientRect();
                const menu = actions.current;
                menu?.style.setProperty(
                  "--actions-top",
                  button.bottom + 4 + "px",
                );
                menu?.style.setProperty(
                  "--actions-right",
                  document.documentElement.clientWidth - button.right + "px",
                );
              }}
              aria-label={t.moreActions}
              title={t.moreActions}
            >
              <Ellipsis size={19} />
            </button>
            <div
              id="session-actions"
              className="session-actions"
              popover="auto"
              ref={actions}
              onClick={() => actions.current?.hidePopover()}
            >
              <button
                disabled={addingRecording}
                onClick={() => createMeeting(project.id)}
              >
                <Plus size={16} />
                {t.newMeeting}
              </button>
              <button onClick={editProject}>
                <Settings2 size={16} />
                {t.projectSettings}
              </button>
              <button
                onClick={() => setRenaming({ projectId: project.id, meeting })}
              >
                <Pencil size={16} />
                {t.renameRecording}
              </button>
              <button
                onClick={() =>
                  void api("meetings/" + meeting.id + "/reveal", {}).catch(
                    (e) => error(String(e)),
                  )
                }
              >
                <FolderOpen size={16} />
                {t.reveal}
              </button>
              <a href={"/api/meetings/" + meeting.id + "/export"} download>
                <Download size={16} />
                {t.export}
              </a>
            </div>
            {!chatOpen && (
              <button
                ref={chatToggle}
                className={replyWaiting ? "chat-reply-link" : "icon-btn"}
                onClick={() => showChat(true)}
                aria-label={replyWaiting ? t.viewChatReply : t.openChat}
                title={replyWaiting ? t.viewChatReply : t.openChat}
                aria-controls="chat-panel"
                aria-expanded={chatOpen}
                aria-haspopup={compactChat ? "dialog" : undefined}
              >
                <MessagesSquare size={17} />
                {replyWaiting && <span>{t.viewChatReply}</span>}
              </button>
            )}
          </header>
          {runtime?.speech.ready === false && (
            <div className="notice" role="status">
              <CircleAlert size={15} />
              <span>
                {t.speechMissing} · {t.installSpeech}
              </span>
              <button className="notice-action" onClick={refresh}>
                {t.refresh}
              </button>
            </div>
          )}
          {relevantNotice && (
            <MeetingNotice
              key={[meeting.id, notice.code, notice.detail].join(":")}
              notice={notice}
              editProject={editProject}
              error={error}
            />
          )}
          <Timeline
            key={meeting.id}
            client={client}
            target={translationTarget(meeting.settings)}
            editing={meeting.settings.editing}
            ask={setQuotation}
            quoting={!!quotation}
          />
        </main>
      </WorkspacePanes>
      {renaming && (
        <RenameRecording
          {...renaming}
          close={() => setRenaming(null)}
          saved={reload}
        />
      )}
    </div>
  );
}
