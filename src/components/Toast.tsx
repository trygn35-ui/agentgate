import { AlertCircle, CheckCircle2, Clipboard, X } from "lucide-react";
import type { ReactElement } from "react";
import type { ToastState } from "../ui-types";

interface ToastProps {
  toast: ToastState;
  onClose: () => void;
  onUndo?: () => void;
}

function ToastIcon({ kind }: Pick<ToastState, "kind">): ReactElement {
  if (kind === "success") return <CheckCircle2 size={16} />;
  if (kind === "error") return <AlertCircle size={16} />;
  return <Clipboard size={16} />;
}

/**
 * 展示操作反馈，并在可撤销的方案切换后提供短时撤销入口。
 *
 * @param props 提示内容、关闭回调及可选撤销回调。
 * @returns 固定在窗口底部居中的深色提示胶囊。
 */
export function Toast({ toast, onClose, onUndo }: ToastProps): ReactElement {
  return (
    <div className="toast" role="status">
      <span className={`toast-icon ${toast.kind}`}><ToastIcon kind={toast.kind} /></span>
      <span>{toast.message}</span>
      {onUndo && <button type="button" className="toast-undo" onClick={onUndo}>撤销</button>}
      <button type="button" className="toast-close" title="关闭" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}
