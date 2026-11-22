import type { IncomingMessage, ServerResponse } from "node:http";

export function fileDisposition(kind: "attachment" | "inline", name: string) {
  const fallback = name.replace(/[^a-z0-9._ -]/gi, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
  );
  return kind + '; filename="' + fallback + "\"; filename*=UTF-8''" + encoded;
}

export function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
export async function readObject(req: IncomingMessage) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json"))
    throw new Error("JSON content is required");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 64000) throw new Error("Request is too large");
    chunks.push(data);
  }
  const value = chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
    : {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A JSON object is required");
  return value;
}
export interface Route {
  req: IncomingMessage;
  res: ServerResponse;
  id: string;
  action: string;
}
export function unknown(res: ServerResponse) {
  return json(res, { error: "Unknown endpoint" }, 404);
}
