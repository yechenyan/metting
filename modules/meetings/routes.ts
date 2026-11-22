import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { json, readObject, unknown, type Route } from "../../shared/http.ts";
import type { AgentHarness } from "../agent-runtime/types.ts";
import { Meetings } from "./service.ts";
import { audioRoute } from "../audio/routes.ts";
import { translationTarget } from "../transcripts/translation.ts";
import { speakerAssignments } from "../transcripts/speaker-names.ts";
export async function meetingRoute(
  { req, res, id, action }: Route,
  meetings: Meetings,
  harness: AgentHarness,
) {
  const { meeting } = meetings.projects.find(id),
    { journal: log, audio } = meetings.record(id);
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    (action === "audio" || action === "audio-info")
  )
    return audioRoute({ req, res, id, action }, audio, log.rows);
  if (req.method === "GET" && !action) return json(res, log.snapshot());
  if (req.method === "GET" && action === "export") {
    await log.export();
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'attachment; filename="transcript.md"',
    });
    createReadStream(log.markdown)
      .on("error", (error) => res.destroy(error))
      .pipe(res);
    return;
  }
  if (req.method !== "POST") return unknown(res);
  const value = await readObject(req);
  switch (action) {
    case "start":
      meetings.start(id);
      return json(res, { ok: true }, 202);
    case "stop":
      meetings.stop(id);
      return json(res, { ok: true }, 202);
    case "settings": {
      const locked = [
        "language",
        "source",
        "application",
        "inputDevice",
        "inputChannel",
      ] as const;
      if (
        meetings.active === id &&
        locked.some((k) => k in value && value[k] !== meeting.settings[k])
      )
        throw new Error(
          "Stop capture before changing the audio source or language",
        );
      const previous = meeting.settings;
      meetings.projects.configure(meeting, value);
      if (
        previous.language !== meeting.settings.language ||
        (previous.localTranslation !== false) !==
          (meeting.settings.localTranslation !== false) ||
        translationTarget(previous) !== translationTarget(meeting.settings)
      )
        meetings.translationChanged(id);
      meetings.prepare(id);
      if (
        [
          "editing",
          "translate",
          "translationLanguage",
          "model",
          "thinking",
        ].some((key) => key in value)
      )
        meetings.enqueueEditing(id, true);
      return json(res, meeting);
    }
    case "speaker-name": {
      const assignments = speakerAssignments(log.rows, value);
      log.emit({ kind: "speakerAssignment", assignments });
      if (log.state === "idle" || log.state === "interrupted")
        await log.export();
      else await log.flush();
      return json(res, { ok: true });
    }
    case "speaker": {
      const name = String(value.name || "")
          .trim()
          .slice(0, 64),
        speaker = String(value.speaker || "");
      if (!/^S[1-9]\d*$/.test(speaker) || !name)
        throw new Error("A valid speaker and name are required");
      log.emit({ kind: "speaker", id: speaker, name });
      await log.flush();
      return json(res, { ok: true });
    }
    case "retry":
      await harness.info(true);
      meetings.enqueueEditing(id, true);
      return json(res, { ok: true });
    case "retry-translation":
      meetings.retryTranslation(id);
      return json(res, { ok: true });
    case "organize":
      await harness.info(true);
      meetings.editor.organize(meeting, log);
      return json(res, { ok: true });
    case "reveal":
      await promisify(execFile)("open", [log.directory]);
      return json(res, { ok: true });
    default:
      return unknown(res);
  }
}
