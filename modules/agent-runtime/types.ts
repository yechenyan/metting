import type { AgentActivity } from "./activity.ts";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  requests: number;
  context: number | null;
  window: number | null;
}
export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  requests: 0,
  context: null,
  window: null,
});
export interface AgentInfo {
  ready: boolean;
  models: { id: string; label: string; levels: string[] }[];
  reason: string;
}
export interface AgentRun {
  text: string;
  error?: string;
  usage: Usage;
}
export interface AgentStream {
  text?: (delta: string) => void;
  activity?: (step: AgentActivity) => void;
  signal: AbortSignal;
}
export interface AgentConversation {
  directory: string;
  workingDirectory: string;
  initialPrompt?: () => string;
}
export interface AgentRunOptions extends AgentStream {
  conversation?: AgentConversation;
}
export interface AgentHarness {
  info(refresh?: boolean): Promise<AgentInfo>;
  run(
    message: string,
    model: string,
    thinking: string,
    preview: (usage: number) => void,
    options?: AgentRunOptions,
  ): Promise<AgentRun>;
  close?(): void;
  readActivity?(
    directory: string,
    matchesPrompt: (prompt: string) => boolean,
    answer: string,
  ): Promise<AgentActivity[]>;
}
