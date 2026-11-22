import type { AgentActivity } from "../agent-runtime/activity.ts";
import type { OriginalExcerpt } from "../transcripts/original-quotation.ts";

export const chatLimits = {
  question: 3200,
  quote: 4000,
  sources: 48,
  recording: 9000,
  page: 30,
};
export const defaultThread = "default";
export interface ChatThread {
  id: string;
  title: string;
}

export interface ChatReference {
  text: string;
  ids: string[];
  start: number;
  end: number;
  speaker: string;
  original?: OriginalExcerpt[];
}
export interface ChatRequest {
  id: string;
  question: string;
  reference: ChatReference | null;
  model: string;
  thinking: string;
}
export type ChatError =
  | "login"
  | "models"
  | "runtime"
  | "limited"
  | "failed"
  | "interrupted"
  | "storage";
export interface ChatTurn extends ChatRequest {
  answer: string;
  status: "answering" | "complete" | "failed" | "stopped";
  error?: ChatError;
  detail?: string;
  tokens: number;
  liveTokens?: number;
  recordingCursor?: number;
  activity?: AgentActivity[];
}
export interface ChatPage {
  turns: ChatTurn[];
  hasEarlier: boolean;
}
export type ChatEvent =
  | ({ kind: "snapshot"; totalTokens: number } & ChatPage)
  | { kind: "turn"; turn: ChatTurn; totalTokens: number }
  | {
      kind: "delta";
      id: string;
      text: string;
      liveTokens?: number;
      activity?: AgentActivity[];
    };
