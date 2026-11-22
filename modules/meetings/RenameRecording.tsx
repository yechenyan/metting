import { useState, type FormEvent } from "react";
import { Modal } from "../../apps/web/Modal";
import { api, t } from "../../apps/web/lib";
import type { Meeting } from "./types";

export function RenameRecording({
  projectId,
  meeting,
  close,
  saved,
}: {
  projectId: string;
  meeting: Meeting;
  close: () => void;
  saved: () => void;
}) {
  const [name, setName] = useState(meeting.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    try {
      await api(
        "projects/" + projectId + "/meetings",
        { id: meeting.id, name: name.trim() },
        "PATCH",
      );
      saved();
      close();
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  }
  return (
    <Modal title={t.renameRecording} close={close}>
      <form className="form" onSubmit={submit}>
        <label>
          {t.recordingName}
          <input
            autoFocus
            required
            maxLength={100}
            value={name}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button className="button primary" disabled={saving || !name.trim()}>
            {t.save}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
