import { getMessage } from "@/utils/i18n";

import "./ConfirmDialog.css";

export type ConfirmDialogProps = {
  visible: boolean;
  title: string;
  message: string;
  items?: string[];
  warning?: string;
  icon?: string;
  confirmText?: string;
  cancelText?: string;
  confirmingText?: string;
  isConfirming?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  visible,
  title,
  message,
  items = [],
  warning,
  icon = "⚠️",
  confirmText = getMessage("confirmButton"),
  cancelText = getMessage("cancelButton"),
  confirmingText = getMessage("processingStatus"),
  isConfirming = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!visible) {
    return null;
  }

  return (
    <div className="confirmation-dialog" onClick={onCancel}>
      <div className="dialog-content" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <span className="dialog-icon">{icon}</span>
          <h3 className="dialog-title">{title}</h3>
        </div>

        <div className="dialog-body">
          <p className="dialog-message">{message}</p>

          {items.length > 0 ? (
            <ul className="dialog-list">
              {items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}

          {warning ? (
            <div className="dialog-warning">
              <strong>{warning}</strong>
            </div>
          ) : null}
        </div>

        <div className="dialog-actions">
          <button type="button" className="dialog-button cancel-button" onClick={onCancel}>
            {cancelText}
          </button>
          <button
            type="button"
            className="dialog-button confirm-button"
            disabled={isConfirming}
            onClick={onConfirm}
          >
            {isConfirming ? confirmingText : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
