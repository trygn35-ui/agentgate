import { useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import { useI18n } from "../i18n";

interface ConfirmDialogProps {
  title: string;
  message: string;
  /** 正文下面的明细区。删会话时用来摆出「要删什么、又特意保留什么」。 */
  details?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 应用内确认弹窗，替代系统原生 confirm。
 *
 * Escape 或点击遮罩视为取消；确认按钮默认聚焦，危险操作使用红色主按钮。
 */
export function ConfirmDialog({
  title,
  message,
  details,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactElement {
  const { m } = useI18n();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelText = cancelLabel ?? m.confirm.cancel;

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div
      className="editor-layer"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      style={{ zIndex: 85 }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <button type="button" className="editor-scrim" aria-label={cancelText} onClick={onCancel} />
      <div className="confirm-dialog">
        <h2>{title}</h2>
        <p>{message}</p>
        {details}
        <div className="confirm-foot">
          <button type="button" className="btn-ghost" onClick={onCancel}>{cancelText}</button>
          <button
            type="button"
            ref={confirmRef}
            className={danger ? "btn-danger" : "btn-accent"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
