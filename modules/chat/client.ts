import { requestJson } from "../../apps/web/lib";
import type { ChatEvent, ChatPage, ChatRequest, ChatTurn } from "./types";
import { defaultThread } from "./types";
import { mergeActivity, type AgentActivity } from "../agent-runtime/activity";

interface ConversationView extends ChatPage {
  connected: boolean;
  totalTokens: number;
}
export class ChatClient {
  private view: ConversationView = {
    turns: [],
    hasEarlier: false,
    totalTokens: 0,
    connected: false,
  };
  private listeners = new Set<() => void>();
  private intent?: { signature: string; id: string };
  constructor(
    private meeting: string,
    private endpoint = "/api/chat/",
    private thread = defaultThread,
  ) {}
  private path(action: string, params = new URLSearchParams()) {
    params.set("thread", this.thread);
    return this.endpoint + this.meeting + "/" + action + "?" + params;
  }
  read = () => this.view;
  connected = () => this.view.connected;
  active = () => {
    const last = this.view.turns.at(-1);
    return last?.status === "answering" ? last.id : "";
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<ConversationView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  open() {
    const stream = new EventSource(this.path("events"));
    stream.onmessage = (event) => this.receive(JSON.parse(event.data));
    stream.onerror = () => {
      if (this.view.connected) this.update({ connected: false });
    };
    return () => {
      stream.close();
      this.update({ connected: false });
    };
  }
  private receive(event: ChatEvent) {
    const previous = this.view.turns;
    if (event.kind === "snapshot") {
      const boundary = previous.findIndex((t) => t.id === event.turns[0]?.id);
      const earlier = boundary > 0 ? previous.slice(0, boundary) : [];
      this.update({
        turns: [...earlier, ...event.turns],
        hasEarlier: earlier.length ? this.view.hasEarlier : event.hasEarlier,
        totalTokens: event.totalTokens,
        connected: true,
      });
    } else if (event.kind === "turn") {
      const index = previous.findIndex((t) => t.id === event.turn.id);
      const turns = previous.slice();
      turns[index < 0 ? turns.length : index] = event.turn;
      this.update({ turns, totalTokens: event.totalTokens });
    } else {
      const last = previous.at(-1);
      if (last?.id !== event.id || last.status !== "answering") return;
      const turns = previous.slice();
      turns[turns.length - 1] = {
        ...last,
        answer: last.answer + event.text,
        liveTokens: event.liveTokens,
        activity: event.activity
          ? mergeActivity(last.activity, event.activity)
          : last.activity,
      };
      this.update({ turns });
    }
  }
  async earlier() {
    const first = this.view.turns[0];
    if (!first || !this.view.hasEarlier) return;
    const page = await requestJson<ChatPage>(
      this.path("history", new URLSearchParams({ before: first.id })),
    );
    if (first.id === this.view.turns[0]?.id)
      this.update({
        turns: [...page.turns, ...this.view.turns],
        hasEarlier: page.hasEarlier,
      });
  }
  async readActivity(id: string) {
    const { activity } = await requestJson<{ activity: AgentActivity[] }>(
      this.path("activity", new URLSearchParams({ question: id })),
    );
    return activity;
  }
  async submit(draft: Omit<ChatRequest, "id">) {
    const signature = JSON.stringify(draft);
    if (this.intent?.signature !== signature)
      this.intent = { signature, id: crypto.randomUUID() };
    const id = this.intent.id;
    try {
      await requestJson(this.path("messages"), { ...draft, id });
    } catch (error) {
      if (!this.view.turns.some((turn) => turn.id === id)) throw error;
    }
    if (this.intent?.id === id) this.intent = undefined;
  }
  stop(id: ChatTurn["id"]) {
    return requestJson(this.path("stop"), { id });
  }
}

export function chatEndpoint(native: boolean) {
  const port = document.querySelector<HTMLMetaElement>(
    'meta[name="meeting-chat-port"]',
  )?.content;
  if (native || !port || !/^\d{1,5}$/.test(port) || Number(port) > 65535)
    return "/api/chat/";
  const url = new URL("/api/chat/", location.href);
  url.port = port;
  return url.href;
}
