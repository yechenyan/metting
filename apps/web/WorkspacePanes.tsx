import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { t } from "./lib";

type Side = "projects" | "chat";
type Widths = Record<Side, number>;
const initial: Widths = { projects: 202, chat: 312 };
const minimum: Widths = { projects: 154, chat: 236 };
const readerMinimum = 360;
const storageKey = "meeting.desk.paneWidths";
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.round(value)));

function savedWidths(): Widths {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    const width = (side: Side) =>
      Number.isFinite(saved?.[side]) && saved[side] >= minimum[side]
        ? saved[side]
        : initial[side];
    return { projects: width("projects"), chat: width("chat") };
  } catch {
    return initial;
  }
}

function Divider({
  side,
  width,
  max,
  resize,
}: {
  side: Side;
  width: number;
  max: number;
  resize: (value: number, save: boolean) => void;
}) {
  const drag = useRef<{
    id: number;
    x: number;
    start: number;
    next: number;
  } | null>(null);
  const frame = useRef(0);
  const direction = side === "projects" ? 1 : -1;
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  return (
    <div
      className="pane-divider"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={side === "projects" ? t.resizeProjects : t.resizeChat}
      aria-controls={side === "projects" ? "projects-panel" : "chat-panel"}
      aria-valuemin={minimum[side]}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={width + " px"}
      title={t.resizePanelHint}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = "";
        drag.current = {
          id: event.pointerId,
          x: event.clientX,
          start: width,
          next: width,
        };
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        active.next = active.start + direction * (event.clientX - active.x);
        if (!frame.current)
          frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            if (drag.current) resize(drag.current.next, false);
          });
      }}
      onPointerUp={(event) => {
        const active = drag.current;
        if (!active || active.id !== event.pointerId) return;
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        drag.current = null;
        delete event.currentTarget.dataset.dragging;
        resize(active.start + direction * (event.clientX - active.x), true);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        resize(drag.current.start, false);
        drag.current = null;
        delete event.currentTarget.dataset.dragging;
      }}
      onDoubleClick={() => resize(initial[side], true)}
      onKeyDown={(event) => {
        const step = direction * (event.shiftKey ? 48 : 12);
        const next = {
          ArrowLeft: width - step,
          ArrowRight: width + step,
          Home: minimum[side],
          End: max,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        resize(next, true);
      }}
    />
  );
}

export function WorkspacePanes({
  projects,
  chat,
  children,
  projectsDocked,
  chatDocked,
}: {
  projects: ReactNode;
  chat: ReactNode;
  children: ReactNode;
  projectsDocked: boolean;
  chatDocked: boolean;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(
    () => document.documentElement.clientWidth,
  );
  const [preferred, setPreferred] = useState(savedWidths);
  useLayoutEffect(() => {
    const el = body.current!;
    const update = () => setAvailable(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const budget =
    available - readerMinimum - Number(projectsDocked) - Number(chatDocked);
  const left = projectsDocked
    ? clamp(
        preferred.projects,
        minimum.projects,
        budget - (chatDocked ? minimum.chat : 0),
      )
    : 0;
  const right = chatDocked
    ? clamp(preferred.chat, minimum.chat, budget - left)
    : 0;
  const style = {
    "--project-width": left + "px",
    "--chat-width": right + "px",
  } as CSSProperties;
  function divider(side: Side) {
    const max = Math.max(
      minimum[side],
      budget - (side === "projects" ? right : left),
    );
    return (
      <Divider
        side={side}
        width={side === "projects" ? left : right}
        max={max}
        resize={(value, save) => {
          const next = {
            projects: projectsDocked ? left : preferred.projects,
            chat: chatDocked ? right : preferred.chat,
            [side]: clamp(value, minimum[side], max),
          };
          setPreferred(next);
          if (save) {
            try {
              localStorage.setItem(storageKey, JSON.stringify(next));
            } catch {
              /* Storage may be unavailable. */
            }
          }
        }}
      />
    );
  }
  return (
    <div className="desk-body" ref={body} style={style}>
      {projects}
      {projectsDocked && divider("projects")}
      {children}
      {chatDocked && divider("chat")}
      {chat}
    </div>
  );
}
