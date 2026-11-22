import { WebSocket } from "ws";

const initialBytes = new WeakMap<WebSocket, number>();
const maxPendingChanges = 1024 * 1024;

export function send(ws: WebSocket, packet: object, initial = false) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > (initialBytes.get(ws) ?? 0) + maxPendingChanges) {
    ws.terminate();
    return;
  }
  const payload = JSON.stringify(packet);
  if (initial) {
    // A long meeting may still be flushing its snapshot when live changes arrive.
    initialBytes.set(ws, Buffer.byteLength(payload));
    ws.send(payload, (error) => {
      initialBytes.delete(ws);
      if (error) ws.terminate();
    });
  } else {
    ws.send(payload);
  }
}
