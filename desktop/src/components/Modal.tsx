import {
  useEffect,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type ModalSize = "sm" | "md" | "lg";

type Props = {
  open: boolean;
  onClose?: () => void;
  title?: ReactNode;
  titleExtra?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: ModalSize;
  /** 无标准标题栏时用（如关闭确认） */
  bare?: boolean;
  className?: string;
  labelledBy?: string;
  dismissOnBackdrop?: boolean;
  zClass?: string;
};

export default function Modal({
  open,
  onClose,
  title,
  titleExtra,
  children,
  footer,
  size = "md",
  bare = false,
  className = "",
  labelledBy,
  dismissOnBackdrop = true,
  zClass = "",
}: Props) {
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function onBackdrop(e: MouseEvent<HTMLDivElement>) {
    if (!dismissOnBackdrop || !onClose) return;
    if (e.target === e.currentTarget) onClose();
  }

  const cardClass = [
    "modal-card",
    `modal-${size}`,
    bare ? "modal-bare" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return createPortal(
    <div
      className={`modal-backdrop${zClass ? ` ${zClass}` : ""}`}
      onClick={onBackdrop}
    >
      <div
        className={cardClass}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onClick={(e) => e.stopPropagation()}
      >
        {!bare && (title != null || onClose) ? (
          <div className="modal-head">
            <div className="modal-title">
              {typeof title === "string" ? <strong>{title}</strong> : title}
              {titleExtra}
            </div>
            {onClose ? (
              <button
                type="button"
                className="modal-close"
                aria-label="关闭"
                onClick={onClose}
              >
                ×
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
