import { createRoot } from "react-dom/client";
import { useCallback, useState, useEffect, useRef } from "react";
import { AudioLines, CircleAlert, X } from "lucide-react";
import { ProjectForm } from "../../modules/projects/ui";
import { Connection } from "../../modules/agent-runtime/Connection";
import type { Project } from "../../modules/projects/types";
import type { Meeting, Settings } from "../../modules/meetings/types";
import { Desk } from "./Desk";
import { chatEndpoint } from "../../modules/chat/client";
import { api, t, type Runtime } from "./lib";
import "@fontsource/barlow/latin-400.css";
import "@fontsource/barlow/latin-600.css";
import "./style.css";
const desktop = window.matchMedia("(min-width: 781px)");
const sidebarPreference = "meeting.desk.projectSidebar";
function initialSidebar() {
  return (
    desktop.matches && localStorage.getItem(sidebarPreference) !== "closed"
  );
}
function App() {
  const [projects, setProjects] = useState<Project[]>([]),
    [chatUrl, setChatUrl] = useState("/api/chat/"),
    [addingRecording, setAddingRecording] = useState(false),
    [active, setActive] = useState<string | null>(null),
    [runtime, setRuntime] = useState<Runtime | null>(null);
  const [selected, setSelected] = useState(
    () => localStorage.getItem("meeting.desk.selected") || "",
  );
  const [modal, setModal] = useState<"new" | "edit" | "login" | null>(null),
    [sidebar, setSidebar] = useState(initialSidebar),
    [wide, setWide] = useState(desktop.matches),
    [error, setError] = useState("");
  const bootstrapVersion = useRef(0);
  const reload = useCallback(async () => {
    const version = ++bootstrapVersion.current;
    try {
      const b = await api<{
        projects: Project[];
        active: string | null;
        features?: { chat?: boolean };
      }>("bootstrap");
      if (version !== bootstrapVersion.current) return;
      setProjects(b.projects);
      setChatUrl(chatEndpoint(b.features?.chat === true));
      setActive(b.active);
    } catch (e) {
      if (version === bootstrapVersion.current) setError(String(e));
    }
  }, []);
  const status = useCallback(async (refresh = false) => {
    const r = await api<Runtime>("status" + (refresh ? "?refresh=1" : ""));
    setRuntime(r);
    return r;
  }, []);
  useEffect(() => {
    const resize = () => {
      setWide(desktop.matches);
      setSidebar(initialSidebar());
    };
    desktop.addEventListener("change", resize);
    return () => desktop.removeEventListener("change", resize);
  }, []);
  function showSidebar(open: boolean) {
    setSidebar(open);
    if (desktop.matches)
      localStorage.setItem(sidebarPreference, open ? "open" : "closed");
  }
  useEffect(() => {
    void reload();
    void status().catch((e) => setError(String(e)));
    const focus = () => {
      void status().catch(() => {});
      void reload();
    };
    window.addEventListener("focus", focus);
    window.addEventListener("meeting-reconnected", reload);
    window.addEventListener("meeting-project-changed", reload);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("meeting-reconnected", reload);
      window.removeEventListener("meeting-project-changed", reload);
    };
  }, [reload, status]);
  useEffect(() => {
    const activity = (e: Event) =>
      setActive((e as CustomEvent<string | null>).detail);
    window.addEventListener("meeting-activity", activity);
    return () => window.removeEventListener("meeting-activity", activity);
  }, []);
  const project =
    projects.find((p) => p.meetings.some((m) => m.id === selected)) ||
    projects[0];
  const meeting =
    project?.meetings.find((m) => m.id === selected) || project?.meetings[0];
  function choose(id: string) {
    setSelected(id);
    localStorage.setItem("meeting.desk.selected", id);
    if (!desktop.matches) setSidebar(false);
    setError("");
  }
  const updateChain = useRef(Promise.resolve());
  function change(v: Partial<Settings>) {
    const id = meeting!.id;
    const next = updateChain.current
      .catch(() => {})
      .then(async () => {
        const updated = await api<Meeting>("meetings/" + id + "/settings", v);
        bootstrapVersion.current++;
        setProjects((prev) =>
          prev.map((p) => ({
            ...p,
            meetings: p.meetings.map((m) =>
              m.id === updated.id ? updated : m,
            ),
          })),
        );
      });
    updateChain.current = next;
    return next;
  }
  return (
    <>
      {project && meeting ? (
        <Desk
          key={meeting.id}
          chatUrl={chatUrl}
          {...{ project, meeting, projects, runtime, reload, change }}
          activeId={active}
          createProject={() => setModal("new")}
          editProject={() => setModal("edit")}
          addingRecording={addingRecording}
          createMeeting={async (projectId) => {
            if (addingRecording) return;
            setAddingRecording(true);
            try {
              const m = await api<Meeting>(
                "projects/" + projectId + "/meetings",
                {},
              );
              bootstrapVersion.current++;
              setProjects((prev) =>
                prev.map((p) =>
                  p.id === projectId
                    ? {
                        ...p,
                        meetings: [
                          m,
                          ...p.meetings.filter((item) => item.id !== m.id),
                        ],
                      }
                    : p,
                ),
              );
              choose(m.id);
            } catch (e) {
              setError(String(e));
            } finally {
              setAddingRecording(false);
            }
          }}
          changeMeeting={choose}
          refresh={() => void status(true).catch((e) => setError(String(e)))}
          login={() => setModal("login")}
          sidebarOpen={sidebar}
          mobileDrawer={sidebar && !wide}
          setSidebar={showSidebar}
          error={setError}
        />
      ) : (
        <main className="loading">
          <AudioLines size={30} />
          <h1>{error ? t.loadFailed : t.loading}</h1>
          {error && (
            <button className="button" onClick={reload}>
              {t.tryAgain}
            </button>
          )}
        </main>
      )}
      {(modal === "new" || modal === "edit") && (
        <ProjectForm
          project={modal === "edit" ? project : undefined}
          pi={runtime?.pi || null}
          close={() => setModal(null)}
          saved={(p) => {
            bootstrapVersion.current++;
            setProjects((prev) => [p, ...prev.filter((x) => x.id !== p.id)]);
            if (modal === "new") choose(p.meetings[0].id);
            setModal(null);
          }}
        />
      )}
      {modal === "login" && (
        <Connection
          runtime={runtime?.pi ?? null}
          close={() => setModal(null)}
          refresh={async () => {
            const r = await status(true);
            if (r.pi.ready && meeting)
              await api("meetings/" + meeting.id + "/retry", {});
          }}
        />
      )}
      {error && (
        <div className="toast" role="alert">
          <CircleAlert size={16} />
          <span>{error}</span>
          <button aria-label={t.close} onClick={() => setError("")}>
            <X size={15} />
          </button>
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
