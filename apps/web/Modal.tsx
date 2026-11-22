import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { t } from "./lib";
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const titleId = useId(),
    ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="modal-inner">
        <header>
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" aria-label={t.close} onClick={close}>
            <X size={19} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
