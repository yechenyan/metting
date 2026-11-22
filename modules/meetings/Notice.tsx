import { useState } from "react";
import { ArrowUpRight, CircleAlert, X } from "lucide-react";
import { Modal } from "../../apps/web/Modal";
import { api, t } from "../../apps/web/lib";
import { isCapturePermission } from "../speech/capture/permissions";
import type { Notice } from "./types";

export function MeetingNotice({
  notice,
  editProject,
  error,
}: {
  notice: Notice;
  editProject: () => void;
  error: (s: string) => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [details, setDetails] = useState(false);
  if (dismissed) return null;
  const permission = isCapturePermission(notice.code);
  return (
    <div className="notice" role="status">
      <CircleAlert size={15} />
      <span>
        {t.notifications[notice.code as keyof typeof t.notifications] ||
          notice.code}
      </span>
      {notice.code === "recordingLimitReached" && (
        <button className="notice-action" onClick={editProject}>
          {t.projectSettings}
          <ArrowUpRight size={13} />
        </button>
      )}
      {permission && (
        <button
          className="notice-action"
          onClick={() =>
            void api("permissions/" + notice.code, {}).catch(() =>
              error(t.openSettingsFailed),
            )
          }
        >
          {t.openSettings}
          <ArrowUpRight size={13} />
        </button>
      )}
      {!permission && notice.detail && (
        <button className="notice-action" onClick={() => setDetails(true)}>
          {t.errorDetails}
        </button>
      )}
      <button
        className="small-icon"
        aria-label={t.close}
        title={t.close}
        onClick={() => setDismissed(true)}
      >
        <X size={14} />
      </button>
      {details && (
        <Modal title={t.errorDetails} close={() => setDetails(false)}>
          <p className="diagnostic">{notice.detail}</p>
        </Modal>
      )}
    </div>
  );
}
