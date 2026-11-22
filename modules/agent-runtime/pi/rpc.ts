import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { bindSessionDirectory } from "./session.ts";
import { PiActivity } from "./activity.ts";
import { readSavedActivity } from "./saved-activity.ts";
import { piRuntime, subscriptionEnv } from "./launch.mjs";
import type {
  AgentHarness,
  AgentConversation,
  AgentRun,
  AgentRunOptions,
  AgentStream,
} from "../types.ts";
import { type AgentInfo } from "../types.ts";
const exec = promisify(execFile);
type RecordData = Record<string, any>;
type Callback = (record: RecordData) => void;
class Rpc {
  private child: ChildProcessWithoutNullStreams;
  private waiting = new Map<
    string,
    { resolve: Callback; reject: (e: Error) => void }
  >();
  private events = new Set<Callback>();
  readonly exited: Promise<void>;
  dead = false;
  constructor(
    instructions: string,
    readonly cwd?: string,
    readonly sessionFile?: string,
  ) {
    const { node, cli } = piRuntime();
    this.child = spawn(
      node,
      [
        cli,
        "--mode",
        "rpc",
        ...(sessionFile
          ? ["--session", sessionFile, "--tools", "*", "--append-system-prompt"]
          : [
              "--no-session",
              "--no-tools",
              "--no-extensions",
              "--no-mcp",
              "--no-skills",
              "--no-context-files",
              "--no-prompt-templates",
              "--system-prompt",
            ]),
        instructions,
      ],
      {
        cwd,
        env: subscriptionEnv(),
        stdio: "pipe",
      },
    );
    let tail = "";
    this.child.stdout.setEncoding("utf8").on("data", (s: string) => {
      tail += s;
      let index;
      while ((index = tail.indexOf("\n")) >= 0) {
        const line = tail.slice(0, index);
        tail = tail.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const waiter = this.waiting.get(msg.id);
          if (msg.type === "response" && waiter) {
            this.waiting.delete(msg.id);
            if (msg.success) waiter.resolve(msg.data || {});
            else waiter.reject(new Error(msg.error || "Pi command failed"));
          } else for (const callback of this.events) callback(msg);
        } catch {
          /* Ignore non-protocol output. */
        }
      }
    });
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.close());
    this.child.on("error", () => this.close());
    this.exited = new Promise((resolve) =>
      this.child.once("close", () => {
        this.close();
        resolve();
      }),
    );
  }
  close() {
    if (this.dead) return;
    this.dead = true;
    this.child.kill();
    for (const { reject } of this.waiting.values())
      reject(new Error("Pi process stopped"));
    this.waiting.clear();
    for (const callback of this.events) callback({ type: "closed" });
  }
  command(type: string, params: RecordData = {}): Promise<RecordData> {
    if (this.dead) return Promise.reject(new Error("Pi is unavailable"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("Pi command timed out"));
      }, 20000);
      this.waiting.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ id, type, ...params }) + "\n");
    });
  }
  async prompt(
    message: string,
    preview: (usage: number) => void,
    stream?: AgentStream,
  ) {
    let assistant: RecordData = {};
    let completedTokens = 0;
    const activity = stream?.activity
      ? new PiActivity(stream.activity)
      : undefined;
    let settle!: () => void, fail!: (e: Error) => void;
    const settled = new Promise<void>((ok, bad) => {
      settle = ok;
      fail = bad;
    });
    void settled.catch(() => {});
    const onEvent = (msg: RecordData) => {
      activity?.event(msg);
      const update = msg.assistantMessageEvent;
      if (
        msg.type === "message_update" &&
        update?.type === "text_delta" &&
        typeof update.delta === "string"
      )
        stream?.text?.(update.delta);
      if (msg.type === "message_end" && msg.message?.role === "assistant") {
        assistant = msg.message;
        if (Number.isFinite(assistant.usage?.totalTokens)) {
          completedTokens += assistant.usage.totalTokens;
          preview(completedTokens);
        }
      }
      const tokens = msg.message?.usage?.totalTokens ?? msg.usage?.totalTokens;
      if (msg.type === "message_update" && Number.isFinite(tokens))
        preview(completedTokens + tokens);
      if (msg.type === "agent_settled") settle();
      if (msg.type === "closed")
        fail(new Error("Pi stopped during the request"));
    };
    this.events.add(onEvent);
    const timer = this.sessionFile
      ? undefined
      : setTimeout(() => {
          fail(new Error("Pi request timed out"));
          this.close();
        }, 110000);
    try {
      const response = await this.command("prompt", { message });
      if (response.disposition !== "handled") await settled;
      return assistant;
    } finally {
      clearTimeout(timer);
      this.events.delete(onEvent);
    }
  }
}
export class PiHarness implements AgentHarness {
  readActivity = readSavedActivity;
  constructor(
    private instructions: string,
    private catalog?: Pick<AgentHarness, "info">,
  ) {}
  private rpc?: Rpc;
  private providers: string[] = [];
  private cached?: { time: number; info: AgentInfo };
  private checking?: Promise<AgentInfo>;
  private transport() {
    if (!this.rpc || this.rpc.dead) this.rpc = new Rpc(this.instructions);
    return this.rpc;
  }
  private async chatTransport(conversation: AgentConversation) {
    const cwd = await realpath(conversation.workingDirectory);
    const file = resolve(conversation.directory, "pi-session.jsonl");
    if (
      this.rpc?.cwd === cwd &&
      this.rpc.sessionFile === file &&
      !this.rpc.dead
    )
      return this.rpc;
    if (this.rpc) {
      this.rpc.close();
      await this.rpc.exited;
    }
    await bindSessionDirectory(file, cwd);
    return (this.rpc = new Rpc(this.instructions, cwd, file));
  }
  info(refresh = false): Promise<AgentInfo> {
    if (this.catalog) return this.catalog.info(refresh);
    if (!refresh && this.cached && Date.now() - this.cached.time < 30000)
      return Promise.resolve(this.cached.info);
    if (this.checking) return this.checking;
    this.checking = this.check()
      .then((info) => {
        this.cached = { time: Date.now(), info };
        return info;
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }
  private async check(): Promise<AgentInfo> {
    try {
      const { node, cli } = piRuntime();
      const results = await Promise.all(
        ["openai", "openai-codex"].map(async (provider) => {
          try {
            const { stdout } = await exec(
              node,
              [
                cli,
                "auth",
                "check",
                "--provider",
                provider,
                "--json",
                "--no-refresh",
              ],
              { env: subscriptionEnv(), timeout: 12000 },
            );
            const r = JSON.parse(stdout);
            return r.status === "ready" && r.authType === "oauth"
              ? provider
              : "";
          } catch {
            return "";
          }
        }),
      );
      this.providers = results.filter(Boolean);
      if (!this.providers.length)
        return { ready: false, models: [], reason: "login" };
      const rpc = this.transport();
      const [{ models }, state] = await Promise.all([
        rpc.command("get_available_models"),
        rpc.command("get_state"),
      ]);
      const available = (models as RecordData[])
        .filter(
          (m) =>
            this.providers.includes(m.provider) &&
            (!m.type || m.type === "chat"),
        )
        .map((m) => ({
          id: m.provider + "/" + m.id,
          label: m.name || m.id,
          levels: m.reasoning
            ? [
                "off",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ].filter(
                (level) =>
                  m.thinkingLevelMap?.[level] !== null &&
                  (!["xhigh", "max"].includes(level) ||
                    m.thinkingLevelMap?.[level] !== undefined),
              )
            : ["off"],
        }));
      const current = state.model?.provider + "/" + state.model?.id;
      available.sort(
        (a, b) =>
          Number(b.id === current) - Number(a.id === current) ||
          Number(b.id.endsWith("-sol")) - Number(a.id.endsWith("-sol")) ||
          b.id.localeCompare(a.id, "en", { numeric: true }),
      );
      return {
        ready: available.length > 0,
        models: available,
        reason: available.length ? "ready" : "models",
      };
    } catch {
      return { ready: false, models: [], reason: "runtime" };
    }
  }
  async run(
    message: string,
    requested: string,
    thinking: string,
    preview: (usage: number) => void,
    options?: AgentRunOptions,
  ): Promise<AgentRun> {
    options?.signal.throwIfAborted();
    const info = await this.info();
    options?.signal.throwIfAborted();
    if (!info.ready) throw new Error(info.reason);
    const selected = requested
      ? info.models.find((m) => m.id === requested)
      : info.models[0];
    if (!selected)
      throw new Error("The selected subscription model is unavailable");
    const [provider, ...rest] = selected.id.split("/");
    const conversation = options?.conversation;
    const rpc = conversation
      ? await this.chatTransport(conversation)
      : this.transport();
    let prompting = false;
    let abortTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      if (!prompting) return rpc.close();
      void rpc.command("abort").catch(() => rpc.close());
      abortTimer = setTimeout(() => rpc.close(), 3000);
    };
    options?.signal.addEventListener("abort", abort, { once: true });
    try {
      options?.signal.throwIfAborted();
      if (!conversation) {
        const fresh = await rpc.command("new_session");
        if (fresh.cancelled) throw new Error("Pi session was not reset");
      }
      const before = conversation ? await rpc.command("get_session_stats") : {};
      await rpc.command("set_model", { provider, modelId: rest.join("/") });
      const { levels } = await rpc.command("get_available_thinking_levels");
      await rpc.command("set_thinking_level", {
        level: levels.includes(thinking) ? thinking : levels[0],
      });
      options?.signal.throwIfAborted();
      prompting = true;
      const prompt =
        conversation && before.userMessages === 0
          ? (conversation.initialPrompt?.() ?? message)
          : message;
      const reply = await rpc.prompt(prompt, preview, options);
      prompting = false;
      const stats = await rpc.command("get_session_stats");
      const used = (key: string) =>
        (stats.tokens?.[key] ?? 0) - (before.tokens?.[key] ?? 0);
      return {
        text: (reply.content || [])
          .filter((p: RecordData) => p.type === "text")
          .map((p: RecordData) => p.text)
          .join(""),
        error:
          reply.errorMessage ||
          (["error", "aborted"].includes(reply.stopReason)
            ? "Pi request failed"
            : undefined),
        usage: {
          input: used("input"),
          output: used("output"),
          cacheRead: used("cacheRead"),
          cacheWrite: used("cacheWrite"),
          total: used("total"),
          requests:
            (stats.assistantMessages ?? 0) - (before.assistantMessages ?? 0),
          context: stats.contextUsage?.tokens ?? null,
          window: stats.contextUsage?.contextWindow ?? null,
        },
      };
    } catch (error) {
      rpc.close();
      throw error;
    } finally {
      clearTimeout(abortTimer);
      options?.signal.removeEventListener("abort", abort);
    }
  }
  close() {
    this.rpc?.close();
  }
}
