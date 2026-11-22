import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const dataDir = resolve(
  process.env.MEETING_DESK_DATA ||
    join(homedir(), "Library", "Application Support", "MeetingDesk"),
);
export const cacheDir = resolve(
  process.env.MEETING_DESK_CACHE ||
    join(homedir(), "Library", "Caches", "MeetingDesk"),
);
