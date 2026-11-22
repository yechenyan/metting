import { join } from "node:path";
import { cacheDir, root } from "../../shared/paths.mjs";
export const speechPython =
  process.env.MEETING_DESK_PYTHON || join(cacheDir, "runtime", "bin", "python");
export const captureBinary =
  process.env.MEETING_DESK_CAPTURE ||
  join(
    root,
    ".runtime",
    "MeetingDeskCapture.app",
    "Contents",
    "MacOS",
    "MeetingDeskCapture",
  );
