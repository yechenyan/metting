import { useState, type FormEvent } from "react";
import { Modal } from "../../apps/web/Modal";
import { api, nameOf, t } from "../../apps/web/lib";
import { usePart, type TranscriptClient } from "./client";
import { canNameSpeaker, selectedVoice } from "./speaker-names";

export interface SpeakerSelection {
  ids: string[];
  speaker: string;
}

export function SpeakerDialog({
  client,
  selection,
  close,
}: {
  client: TranscriptClient;
  selection: SpeakerSelection;
  close: () => void;
}) {
  const { ids } = selection;
  const row = usePart(client, ids[0], () => client.rows.get(ids[0]));
  const speaker = row
    ? selectedVoice(row, selection.speaker)
    : selection.speaker;
  const [name, setName] = useState(
    () => (row && client.speakerNames.name(row, speaker)) || "",
  );
  const [following, setFollowing] = useState(
    () =>
      (row && client.speakerNames.assignment(row, speaker)?.following) ?? true,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const identified = speaker !== "unknown";
  const available = row && canNameSpeaker(row, speaker);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving || !available || !name.trim()) return;
    setSaving(true);
    setError("");
    try {
      await api("meetings/" + client.meeting + "/speaker-name", {
        ids,
        speaker,
        name: name.trim(),
        following,
      });
      close();
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  }

  return (
    <Modal title={t.renameSpeaker} close={close}>
      <form className="form" onSubmit={save}>
        <label>
          {t.speakerName}
          <input
            autoFocus
            required
            maxLength={64}
            value={name}
            placeholder={row && nameOf(row, client.speakerNames, speaker)}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="speaker-scope">
          <label>
            <input
              type="checkbox"
              checked={following}
              disabled={!available}
              aria-describedby="speaker-scope-hint"
              onChange={(event) => setFollowing(event.target.checked)}
            />
            {t.speakerMatchFollowing}
          </label>
          <small id="speaker-scope-hint">
            {following
              ? identified
                ? t.speakerMatchHint
                : t.speakerUnconfirmedHint
              : t.speakerOnlyHint}
          </small>
        </div>
        {!available && (
          <p className="error" role="alert">
            {t.speakerPassageChanged}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button
            className="button primary"
            disabled={saving || !available || !name.trim()}
          >
            {t.save}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
