import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getMessage } from '@/utils/i18n';
import type { AttachmentWithPreview } from '../../composables/useAttachments';
import type { RequestState } from '../../composables/useAgentChat';
import FakeCaretOverlay from './FakeCaretOverlay';

type ComposerDrawerProps = {
  open: boolean;
  modelValue: string;
  placeholder?: string;
  attachments: AttachmentWithPreview[];
  attachmentError?: string | null;
  requestState: RequestState;
  sending: boolean;
  cancelling: boolean;
  canCancel: boolean;
  canSend: boolean;
  enableFakeCaret?: boolean;
  leftActions?: ReactNode;
  onClose?: () => void;
  onUpdateModelValue?: (value: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  onAttachmentRemove?: (index: number) => void;
  onPaste?: (event: ClipboardEvent) => void;
};

function getModifierKey(): string {
  if (typeof navigator === 'undefined') {
    return 'Ctrl';
  }

  return /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
}

export default function ComposerDrawer({
  open,
  modelValue,
  placeholder,
  attachments,
  attachmentError,
  requestState,
  sending,
  cancelling,
  canCancel,
  canSend,
  enableFakeCaret,
  leftActions,
  onClose,
  onUpdateModelValue,
  onSubmit,
  onCancel,
  onAttachmentRemove,
  onPaste,
}: ComposerDrawerProps) {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);

  const [teleportTarget, setTeleportTarget] = useState<Element | null>(null);
  const [textareaEl, setTextareaEl] = useState<HTMLTextAreaElement | null>(null);

  const isRequestActive = requestState === 'starting' || requestState === 'ready' || requestState === 'running';

  useEffect(() => {
    const agentTheme = document.querySelector('.agent-theme');
    setTeleportTarget(agentTheme ?? document.body);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    requestAnimationFrame(() => {
      textareaEl?.focus();
    });
  }, [open, textareaEl]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose?.();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, onClose]);

  const modifierKey = useMemo(getModifierKey, []);

  if (!open) {
    return null;
  }

  const content = (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={t('composerDrawerExpandedEditorAria', 'Expanded editor')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onClose?.();
        }
      }}
    >
      <div className="absolute inset-0 bg-black/40 composer-drawer-backdrop" onClick={() => onClose?.()} />

      <div
        className="absolute inset-x-0 bottom-0 composer-drawer-sheet overflow-hidden flex flex-col"
        style={{
          height: '65vh',
          backgroundColor: 'var(--ac-surface)',
          borderTop: 'var(--ac-border-width) solid var(--ac-border)',
          borderTopLeftRadius: 'var(--ac-radius-card)',
          borderTopRightRadius: 'var(--ac-radius-card)',
          boxShadow: 'var(--ac-shadow-float)',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: 'var(--ac-border-width) solid var(--ac-border)' }}
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: 'var(--ac-text)' }}>
              {t('composerDrawerExpandedEditorTitle', 'Expanded editor')}
            </div>
            <div className="text-[10px]" style={{ color: 'var(--ac-text-subtle)' }}>
              {t('composerDrawerShortcutHint', 'Press {0}+Enter to send', [modifierKey])}
            </div>
          </div>

          <button
            type="button"
            className="p-1.5 transition-colors hover:opacity-80 cursor-pointer"
            style={{
              backgroundColor: 'transparent',
              color: 'var(--ac-text-muted)',
              borderRadius: 'var(--ac-radius-button)',
            }}
            aria-label={t('composerDrawerCloseAria', 'Close expanded editor')}
            onClick={() => onClose?.()}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden flex flex-col px-4 py-3 gap-3">
          {attachments.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {attachments.map((attachment, index) => (
                <div key={`${attachment.name}-${index}`} className="relative group">
                  <div
                    className="w-14 h-14 rounded-lg overflow-hidden"
                    style={{
                      backgroundColor: 'var(--ac-surface-muted)',
                      border: 'var(--ac-border-width) solid var(--ac-border)',
                    }}
                  >
                    {attachment.type === 'image' && attachment.previewUrl ? (
                      <img src={attachment.previewUrl} alt={attachment.name} className="w-full h-full object-cover" />
                    ) : (
                      <div
                        className="w-full h-full flex items-center justify-center"
                        style={{ color: 'var(--ac-text-subtle)' }}
                      >
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                          />
                        </svg>
                      </div>
                    )}
                  </div>

                  <button
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                    style={{ backgroundColor: 'var(--ac-error)', color: 'white' }}
                    title={t('agentComposerRemoveImageTitle', 'Remove image')}
                    onClick={() => onAttachmentRemove?.(index)}
                    type="button"
                  >
                    <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>

                  <div
                    className="absolute bottom-0 left-0 right-0 px-0.5 py-0.5 text-[8px] truncate opacity-0 group-hover:opacity-100 transition-opacity rounded-b-lg"
                    style={{ backgroundColor: 'rgba(0,0,0,0.6)', color: 'white' }}
                  >
                    {attachment.name}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {attachmentError ? (
            <div className="text-xs" style={{ color: 'var(--ac-error)' }}>
              {attachmentError}
            </div>
          ) : null}

          <div className="relative flex-1 min-h-0 flex flex-col">
            <textarea
              ref={setTextareaEl}
              value={modelValue}
              className="w-full flex-1 min-h-0 bg-transparent border-none focus:ring-0 focus:outline-none resize-none p-3 text-sm"
              style={{
                fontFamily: 'var(--ac-font-body)',
                color: 'var(--ac-text)',
                backgroundColor: 'var(--ac-surface-muted)',
                border: 'var(--ac-border-width) solid var(--ac-border)',
                borderRadius: 'var(--ac-radius-card)',
              }}
              placeholder={placeholder}
              onInput={(event) => onUpdateModelValue?.((event.currentTarget as HTMLTextAreaElement).value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && (event.metaKey || event.ctrlKey) && !event.altKey) {
                  event.preventDefault();
                  if (canSend && !sending) {
                    onSubmit?.();
                  }
                }
              }}
              onPaste={(event) => onPaste?.(event.nativeEvent)}
            />

            {enableFakeCaret ? <FakeCaretOverlay textareaRef={textareaEl} enabled={true} value={modelValue} /> : null}
          </div>

          <div className="flex items-center justify-between">
            {leftActions}

            <div className="flex gap-2">
              {isRequestActive && canCancel && !sending ? (
                <button
                  className="px-3 py-1.5 text-xs transition-colors cursor-pointer"
                  style={{
                    backgroundColor: 'var(--ac-hover-bg)',
                    color: 'var(--ac-text)',
                    borderRadius: 'var(--ac-radius-button)',
                  }}
                  disabled={cancelling}
                  onClick={() => onCancel?.()}
                  type="button"
                >
                  {cancelling
                    ? t('agentComposerStatusStopping', 'Stopping...')
                    : t('agentComposerStopTitle', 'Stop')}
                </button>
              ) : null}

              <button
                className="px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
                style={{
                  backgroundColor: canSend ? 'var(--ac-accent)' : 'var(--ac-surface-muted)',
                  color: canSend ? 'var(--ac-accent-contrast)' : 'var(--ac-text-subtle)',
                  borderRadius: 'var(--ac-radius-button)',
                  cursor: canSend ? 'pointer' : 'not-allowed',
                }}
                disabled={!canSend || sending}
                onClick={() => onSubmit?.()}
                type="button"
              >
                {t('agentComposerSendTitle', 'Send')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return teleportTarget ? createPortal(content, teleportTarget) : content;
}
