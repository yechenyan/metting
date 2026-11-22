import { createServer, type IncomingMessage } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, join, sep, extname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer, WebSocket } from "ws";
import { Projects } from "../../modules/projects/repository.ts";
import { Meetings } from "../../modules/meetings/service.ts";
import { audioManifest } from "../../modules/audio/archive.ts";
import { Editor } from "../../modules/ai-editing/editor.ts";
import { DraftTranslations } from "../../modules/local-translation/service.ts";
import { wordsPerPreview } from "../../modules/local-translation/partials.ts";
import { editorInstructions } from "../../modules/ai-editing/context.ts";
import { PiHarness } from "../../modules/agent-runtime/pi/rpc.ts";
import { openLogin } from "../../modules/agent-runtime/pi/login.ts";
import { chooseFolder, projectRoute } from "../../modules/projects/routes.ts";
import { meetingRoute } from "../../modules/meetings/routes.ts";
import { ChatService } from "../../modules/chat/service.ts";
import { chatInstructions } from "../../modules/chat/context.ts";
import { chatRoute } from "../../modules/chat/routes.ts";
import { json, readObject, unknown } from "../../shared/http.ts";
import { speechInfo } from "../../modules/speech/local.ts";
import { dataDir, root } from "../../shared/paths.mjs";
import { captureBinary } from "../../modules/speech/paths.ts";
import { send } from "../../modules/transcripts/socket.ts";
import {
  isCapturePermission,
  permissionPanes,
} from "../../modules/speech/capture/permissions.ts";

const cmd = promisify(execFile),
  projects = new Projects(dataDir),
  harness = new PiHarness(editorInstructions);
const clients = new Map<string, Set<WebSocket>>();
function transient(id: string, evt: object) {
  for (const client of clients.get(id) || []) send(client, evt);
}
const editor = new Editor(
  [harness, new PiHarness(editorInstructions, harness)],
  (id, tokens) => transient(id, { kind: "runningTokens", tokens }),
);
const drafts = new DraftTranslations((value) => {
  for (const id of clients.keys())
    transient(id, { kind: "localTranslation", value });
});
const meetings = new Meetings(
  projects,
  editor,
  transient,
  (active) => {
    for (const group of clients.values())
      for (const ws of group) send(ws, { kind: "activity", active });
  },
  undefined,
  drafts,
);
const chat = new ChatService(
  (id) => {
    const { project, meeting } = projects.find(id);
    return projects.directory(project, meeting);
  },
  (id) => meetings.journal(id),
  () => new PiHarness(chatInstructions, harness),
  (id) => projects.chatWorkspace(id),
);
const port = Number(process.env.MEETING_DESK_PORT || 4317);
const allowed = new Set(["localhost", "127.0.0.1", "[::1]"]);
function local(req: IncomingMessage) {
  try {
    const host = new URL("http://" + req.headers.host);
    if (!allowed.has(host.hostname)) return false;
    return !req.headers.origin || req.headers.origin === host.origin;
  } catch {
    return false;
  }
}
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const dev = process.argv.includes("--dev")
  ? await (
      await import("vite")
    ).createServer({
      server: { middlewareMode: true, hmr: false },
      appType: "spa",
    })
  : null;
const server = createServer(async (req, res) => {
  if (!local(req)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      const [, area, id, action] = url.pathname.split("/").filter(Boolean);
      const route = { req, res, id, action };
      if (area === "projects")
        return await projectRoute(route, projects, (project, limitChanged) => {
          if (limitChanged) meetings.limitChanged(project);
          for (const { id } of project.meetings)
            transient(id, { kind: "projectChanged" });
        });
      if (area === "chat" && id)
        return await chatRoute(route, chat, url.searchParams);
      if (area === "meetings" && id)
        return await meetingRoute(route, meetings, harness);
      if (req.method === "GET") {
        if (area === "bootstrap")
          return json(res, {
            projects: projects.all,
            active: meetings.active,
            features: { chat: true },
          });
        if (area === "status")
          return json(res, {
            speech: speechInfo(),
            pi: await harness.info(url.searchParams.has("refresh")),
          });
        if (area === "applications") {
          if (!existsSync(captureBinary)) return json(res, []);
          const { stdout } = await cmd(captureBinary, ["apps"], {
            timeout: 8000,
          });
          return json(res, JSON.parse(stdout));
        }
        if (area === "inputs") {
          const { stdout } = await cmd(captureBinary, ["inputs"], {
            timeout: 5000,
          });
          return json(res, JSON.parse(stdout));
        }
      }
      if (req.method === "POST") {
        await readObject(req);
        if (area === "permissions" && !action && isCapturePermission(id)) {
          await cmd("open", [permissionPanes[id]]);
          return json(res, { ok: true });
        }
        if (area === "folder") return json(res, await chooseFolder());
        if (area === "pi" && id === "login") {
          await openLogin();
          return json(res, { ok: true });
        }
      }
      return unknown(res);
    }
    if (dev) {
      dev.middlewares(req, res);
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    const base = join(root, "dist/web");
    let file = resolve(base, "." + decodeURIComponent(url.pathname));
    if (file !== base && !file.startsWith(base + sep))
      return json(res, { error: "Invalid path" }, 400);
    if (!existsSync(file) || !statSync(file).isFile())
      file = join(base, "index.html");
    if (!existsSync(file))
      return json(res, { error: "Build the web app with npm run build." }, 503);
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] || "application/octet-stream",
      "Cache-Control": file.includes(sep + "assets" + sep)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
    createReadStream(file).pipe(res);
  } catch (error) {
    json(
      res,
      { error: error instanceof Error ? error.message : "Request failed" },
      400,
    );
  }
});
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost"),
    id = url.searchParams.get("meeting") || "";
  if (!local(req) || url.pathname !== "/events") {
    socket.destroy();
    return;
  }
  try {
    const log = meetings.journal(id);
    wss.handleUpgrade(req, socket, head, (ws) => {
      let group = clients.get(id);
      if (!group) {
        group = new Set();
        clients.set(id, group);
      }
      group.add(ws);
      const listener = (packet: object) =>
        send(ws, { kind: "change", ...packet });
      log.listeners.add(listener);
      const packets = log.since(
        url.searchParams.get("epoch"),
        Number(url.searchParams.get("since")),
      );
      if (packets)
        send(
          ws,
          { kind: "resume", packets, previewWords: wordsPerPreview },
          true,
        );
      else
        send(
          ws,
          {
            kind: "snapshot",
            epoch: log.epoch,
            value: log.snapshot(),
            previewWords: wordsPerPreview,
          },
          true,
        );
      send(ws, { kind: "activity", active: meetings.active });
      send(ws, { kind: "localTranslation", value: drafts.status });
      send(ws, {
        kind: "audio",
        value: audioManifest(meetings.record(id).audio),
      });
      meetings.prepare(id);
      ws.on("error", () => ws.terminate());
      ws.on("close", () => {
        log.listeners.delete(listener);
        group.delete(ws);
        if (!group.size) clients.delete(id);
      });
    });
  } catch {
    socket.destroy();
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log("Meeting Desk is available at http://127.0.0.1:" + port),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const ws of wss.clients) ws.terminate();
  server.close();
  editor.shutdown();
  await chat.close();
  harness.close();
  await meetings.close();
  await dev?.close();
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
