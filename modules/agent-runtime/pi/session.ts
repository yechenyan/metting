import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

// Pi's CLI resumes in the cwd from the JSONL header, even when spawned elsewhere.
// A project relink changes that header while preserving the session ID and every entry.
export async function bindSessionDirectory(file: string, cwd: string) {
  const handle = await open(file, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!handle) return;
  const source = handle.createReadStream();
  const prefix: Buffer[] = [];
  try {
    for await (const chunk of source) {
      const end = chunk.indexOf(10);
      if (end < 0) {
        prefix.push(chunk);
        continue;
      }
      prefix.push(chunk.subarray(0, end));
      const line = Buffer.concat(prefix);
      const header = JSON.parse(line.toString("utf8"));
      if (header.type !== "session" || typeof header.id !== "string")
        throw new Error("Invalid Pi session header");
      if (header.cwd === cwd) return;

      const temp = file + "." + randomUUID() + ".tmp";
      async function* entries() {
        yield JSON.stringify({ ...header, cwd }) + "\n";
        yield* createReadStream(file, { start: line.length + 1 });
      }
      try {
        await pipeline(
          entries(),
          createWriteStream(temp, { flags: "wx", mode: 0o600 }),
        );
        await rename(temp, file);
      } finally {
        await rm(temp, { force: true });
      }
      return;
    }
    throw new Error("Incomplete Pi session header");
  } finally {
    source.destroy();
    await handle.close();
  }
}
