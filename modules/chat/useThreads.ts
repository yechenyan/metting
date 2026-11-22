import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson, t } from "../../apps/web/lib";
import { defaultThread, type ChatThread } from "./types";

export function useThreads(
  meeting: string,
  endpoint: string,
  observing: boolean,
) {
  const key = "meeting.desk.chat.thread." + meeting;
  const url = endpoint + meeting + "/threads";
  const [selected, setSelected] = useState(() => {
    try {
      return localStorage.getItem(key) || defaultThread;
    } catch {
      return defaultThread;
    }
  });
  const [threads, setThreads] = useState<ChatThread[]>([
    { id: defaultThread, title: "" },
  ]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const creatingId = useRef("");
  const inFlight = useRef(false);
  const choose = useCallback(
    (id: string) => {
      setSelected(id);
      try {
        localStorage.setItem(key, id);
      } catch {
        /* Selection still works in memory. */
      }
    },
    [key],
  );
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      const data = await requestJson<{ threads: ChatThread[] }>(url);
      if (generation.current !== version) return;
      setThreads(data.threads);
      setError("");
      if (!data.threads.some((item) => item.id === selected))
        choose(defaultThread);
    } catch {
      if (generation.current === version) setError(t.chatThreadsFailed);
    }
  }, [url, selected, choose]);
  useEffect(() => {
    if (observing) void refresh();
    return () => {
      generation.current++;
    };
  }, [observing, refresh]);
  async function create() {
    if (inFlight.current) return;
    inFlight.current = true;
    setCreating(true);
    setError("");
    generation.current++;
    const id = (creatingId.current ||= crypto.randomUUID());
    try {
      const data = await requestJson<{ threads: ChatThread[] }>(url, { id });
      setThreads(data.threads);
      choose(id);
      creatingId.current = "";
    } catch {
      setError(t.chatCreateFailed);
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  }
  return { selected, threads, choose, create, creating, error, refresh };
}
