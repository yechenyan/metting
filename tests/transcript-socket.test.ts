import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { send } from "../modules/transcripts/socket.ts";

test(
  "a multi-megabyte transcript snapshot can be followed immediately by a live change",
  { timeout: 5000 },
  async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    server.on("connection", (ws) => {
      send(
        ws,
        { kind: "snapshot", history: "x".repeat(3 * 1024 * 1024) },
        true,
      );
      send(ws, { kind: "change", seq: 1 });
    });
    const { port } = server.address() as AddressInfo;
    const client = new WebSocket("ws://127.0.0.1:" + port);
    try {
      const received = await new Promise<string[]>((resolve, reject) => {
        const kinds: string[] = [];
        client.on("error", reject);
        client.on("close", () => reject(new Error("Incomplete snapshot")));
        client.on("message", (bytes) => {
          const packet = JSON.parse(bytes.toString());
          kinds.push(packet.kind);
          if (kinds.length === 2) resolve(kinds);
        });
      });
      assert.deepEqual(received, ["snapshot", "change"]);
    } finally {
      client.terminate();
      for (const ws of server.clients) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
