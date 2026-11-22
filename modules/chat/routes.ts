import { json, readObject, unknown, type Route } from "../../shared/http.ts";
import { ChatBusy, type ChatService } from "./service.ts";
import { chatLimits, type ChatReference, type ChatRequest } from "./types.ts";
import { UnknownThread } from "./threads.ts";
import { defaultThread } from "./types.ts";

function bounded(value: unknown, max: number, optional = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!optional && !value.trim())
  )
    throw new Error("Invalid chat text");
  return value.trim();
}
function reference(value: unknown): ChatReference | null {
  if (value == null) return null;
  if (typeof value !== "object")
    throw new Error("Invalid transcript reference");
  const { ids, start, end, speaker, text, original } = value as ChatReference;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > chatLimits.sources ||
    !Number.isFinite(start) ||
    start < 0 ||
    !Number.isFinite(end) ||
    end < start
  )
    throw new Error("Invalid transcript reference");
  const sourceIds = ids.map((id) => bounded(id, 180));
  if (
    original !== undefined &&
    (!Array.isArray(original) || original.length > sourceIds.length)
  )
    throw new Error("Invalid original selection");
  const unique = new Set<string>();
  let used = 0;
  const excerpts = original?.map((part) => {
    if (!part || !sourceIds.includes(part.id) || unique.has(part.id))
      throw new Error("Invalid original source");
    unique.add(part.id);
    const words = bounded(part.text, chatLimits.quote);
    used += words.length;
    if (used > chatLimits.quote)
      throw new Error("Original selection is too long");
    return { id: part.id, text: words };
  });
  return {
    ids: sourceIds,
    ...(excerpts && { original: excerpts }),
    start,
    end,
    speaker: bounded(speaker, 256, true),
    text: bounded(text, chatLimits.quote),
  };
}
export function chatRequest(body: Record<string, unknown>): ChatRequest {
  const id = bounded(body.id, 64);
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id))
    throw new Error("Invalid question ID");
  return {
    id,
    question: bounded(body.question, chatLimits.question),
    reference: reference(body.reference),
    model: bounded(body.model ?? "", 200, true),
    thinking: bounded(body.thinking ?? "low", 20),
  };
}
export async function chatRoute(
  { req, res, id, action }: Route,
  service: ChatService,
  params: URLSearchParams,
) {
  if (action === "threads") {
    const index = service.threads(id);
    if (req.method === "GET") return json(res, { threads: index.list() });
    if (req.method === "POST") {
      const body = await readObject(req);
      return json(res, { threads: index.create(bounded(body.id, 64)) }, 201);
    }
    return unknown(res);
  }
  let room;
  try {
    room = await service.room(id, params.get("thread") ?? defaultThread);
  } catch (error) {
    if (error instanceof UnknownThread)
      return json(res, { error: error.message }, 404);
    throw error;
  }
  if (req.method === "GET" && action === "events") {
    if (res.destroyed) return;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 1000\n\n");
    let initialBytes = 0;
    const detach = room.subscribe((event) => {
      if (res.destroyed) return;
      if (res.writableLength > initialBytes + 512 * 1024) {
        res.destroy();
        return;
      }
      const packet = "data: " + JSON.stringify(event) + "\n\n";
      if (event.kind === "snapshot") {
        initialBytes = Buffer.byteLength(packet);
        res.write(packet, () => {
          initialBytes = 0;
        });
      } else res.write(packet);
    });
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(": keepalive\n\n");
    }, 25000);
    res.once("close", () => {
      clearInterval(heartbeat);
      detach();
    });
    return;
  }
  if (req.method === "GET" && action === "history")
    return json(res, room.history.page(params.get("before") || undefined));
  if (req.method === "GET" && action === "activity")
    return json(res, {
      activity: await room.readActivity(bounded(params.get("question"), 64)),
    });
  if (req.method === "POST" && action === "messages") {
    const request = chatRequest(await readObject(req));
    try {
      await room.submit(request);
    } catch (error) {
      if (error instanceof ChatBusy)
        return json(res, { error: "chatBusy" }, 409);
      throw error;
    }
    return json(res, { id: request.id }, 202);
  }
  if (req.method === "POST" && action === "stop") {
    const body = await readObject(req);
    room.stop(bounded(body.id, 64));
    return json(res, { ok: true });
  }
  return unknown(res);
}
