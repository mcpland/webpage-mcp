import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { CodexReasoningEffort } from 'webpage-mcp-shared';
import type { ModelDefinition } from '@/common/agent-models';
import { getMessage } from '@/utils/i18n';
import type { AttachmentWithPreview } from '../../composables/useAttachments';
import type { RequestState } from '../../composables/useAgentChat';
import ComposerDrawer from './ComposerDrawer';
import FakeCaretOverlay from './FakeCaretOverlay';

type AgentComposerProps = {
  modelValue: string;
  attachments: AttachmentWithPreview[];
  attachmentError?: string | null;
  isDragOver?: boolean;
  isStreaming: boolean;
  requestState: RequestState;
  sending: boolean;
  cancelling: boolean;
  canCancel: boolean;
  canSend: boolean;
  placeholder?: string;
  engineName?: string;
  selectedModel: string;
  availableModels: ModelDefinition[];
  reasoningEffort?: CodexReasoningEffort;
  availableReasoningEfforts?: readonly CodexReasoningEffort[];
  enableFakeCaret?: boolean;
  onUpdateModelValue?: (value: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  onAttachmentAdd?: () => void;
  onAttachmentRemove?: (index: number) => void;
  onAttachmentDrop?: (event: DragEvent) => void;
  onAttachmentPaste?: (event: ClipboardEvent) => void;
  onAttachmentDragOver?: (event: DragEvent) => void;
  onAttachmentDragLeave?: (event: DragEvent) => void;
  onModelChange?: (modelId: string) => void;
  onReasoningEffortChange?: (effort: CodexReasoningEffort) => void;
  onSessionSettings?: () => void;
  onSessionReset?: () => void;
};

const MIN_HEIGHT = 50;
const MAX_HEIGHT = 200;

export default function AgentComposer({
  modelValue,
  attachments,
  attachmentError,
  isDragOver,
  isStreaming,
  requestState,
  sending,
  cancelling,
  canCancel,
  canSend,
  placeholder,
  engineName,
  selectedModel,
  availableModels,
  reasoningEffort,
  availableReasoningEfforts,
  enableFakeCaret,
  onUpdateModelValue,
  onSubmit,
  onCancel,
  onAttachmentAdd,
  onAttachmentRemove,
  onAttachmentDrop,
  onAttachmentPaste,
  onAttachmentDragOver,
  onAttachmentDragLeave,
  onModelChange,
  onReasoningEffortChange,
  onSessionSettings,
  onSessionReset,
}: AgentComposerProps) {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const modelWidthRef = useRef<HTMLSpanElement | null>(null);
  const [modelSelectWidth, setModelSelectWidth] = useState('auto');
  const [textareaHeight, setTextareaHeight] = useState(MIN_HEIGHT);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const isRequestActive = requestState === 'starting' || requestState === 'ready' || requestState === 'running';
  const isCodexEngine = engineName === 'codex';
  const supportsImages = engineName === 'claude' || engineName === 'codex';
  const showExpandButton = isOverflowing;

  const selectedModelName = useMemo(() => {
    const model = availableModels.find((candidate) => candidate.id === selectedModel);
    return model?.name || selectedModel || '';
  }, [availableModels, selectedModel]);

  useEffect(() => {
    const span = modelWidthRef.current;
    if (!span) {
      return;
    }

    setModelSelectWidth(`${span.offsetWidth + 16}px`);
  }, [selectedModelName, availableModels]);

  const statusText = useMemo(() => {
    if (sending) return t('agentComposerStatusSending', 'Sending...');
    if (cancelling) return t('agentComposerStatusStopping', 'Stopping...');
    if (requestState === 'starting') return t('agentComposerStatusStarting', 'Starting...');
    if (requestState === 'ready') return t('agentComposerStatusPreparing', 'Preparing...');
    if (requestState === 'running') return t('agentComposerStatusWorking', 'Working...');
    return t('agentComposerStatusReady', 'Ready');
  }, [sending, cancelling, requestState, t]);

  const statusColor = sending || isRequestActive ? 'var(--ac-accent)' : 'var(--ac-text-subtle)';

  const primaryActionButtonStyle: CSSProperties = isRequestActive
    ? {
        borderRadius: 'var(--ac-radius-button)',
        border: 'var(--ac-border-width) solid var(--ac-diff-del-border)',
        backgroundColor: 'var(--ac-diff-del-bg)',
        color: 'var(--ac-danger)',
        cursor: cancelling || !canCancel ? 'not-allowed' : 'pointer',
        opacity: cancelling || !canCancel ? 0.6 : 1,
      }
    : {
        borderRadius: 'var(--ac-radius-button)',
        border: 'var(--ac-border-width) solid transparent',
        backgroundColor: canSend ? 'var(--ac-accent)' : 'var(--ac-surface-muted)',
        color: canSend ? 'var(--ac-accent-contrast)' : 'var(--ac-text-subtle)',
        cursor: canSend ? 'pointer' : 'not-allowed',
      };

  const primaryActionDisabled = isRequestActive ? cancelling || !canCancel : !canSend;

  function recalculateHeight(): void {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const currentHeight = textarea.style.height;
    textarea.style.height = 'auto';
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = currentHeight;

    const nextHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, contentHeight));
    setTextareaHeight(nextHeight);
    setIsOverflowing(contentHeight > MAX_HEIGHT + 1);
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      recalculateHeight();
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [modelValue]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === 'undefined') {
      return;
    }

    let lastWidth = textarea.offsetWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.offsetWidth;
      if (nextWidth !== lastWidth) {
        lastWidth = nextWidth;
        recalculateHeight();
      }
    });

    observer.observe(textarea);
    return () => {
      observer.disconnect();
    };
  }, []);

  function handleSubmit(): void {
    onSubmit?.();
  }

  function handlePrimaryAction(): void {
    if (isRequestActive) {
      onCancel?.();
      return;
    }

    handleSubmit();
  }

  function handleReset(): void {
    if (
      window.confirm(
        t(
          'agentComposerResetConfirm',
          'Reset this conversation? All messages will be deleted and the session will start fresh.',
        ),
      )
    ) {
      onSessionReset?.();
    }
  }

  return (
    <div
      className="relative"
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (supportsImages) {
          onAttachmentDragOver?.(event.nativeEvent);
        }
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (supportsImages) {
          onAttachmentDragLeave?.(event.nativeEvent);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (supportsImages) {
          onAttachmentDrop?.(event.nativeEvent);
        }
      }}
    >
      {isDragOver ? (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center rounded-lg pointer-events-none"
          style={{
            backgroundColor: 'var(--ac-accent)',
            opacity: 0.1,
            border: '2px dashed var(--ac-accent)',
          }}
        >
          <span className="text-sm font-medium" style={{ color: 'var(--ac-accent)' }}>
            {t('agentComposerDropImagesHere', 'Drop images here')}
          </span>
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2 mb-2 px-1">
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
        <div className="px-1 mb-1 text-xs" style={{ color: 'var(--ac-error)' }}>
          {attachmentError}
        </div>
      ) : null}

      <div
        className="flex flex-col transition-all"
        style={{
          backgroundColor: 'var(--ac-surface)',
          borderRadius: 'var(--ac-radius-card)',
          border: isDragOver
            ? '2px solid var(--ac-accent)'
            : 'var(--ac-border-width) solid var(--ac-border)',
          boxShadow: 'var(--ac-shadow-float)',
        }}
      >
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={modelValue}
            className={`w-full bg-transparent border-none focus:ring-0 focus:outline-none resize-none p-3 text-sm${showExpandButton ? ' pr-10' : ''}`}
            style={{
              height: `${textareaHeight}px`,
              minHeight: `${MIN_HEIGHT}px`,
              maxHeight: `${MAX_HEIGHT}px`,
              overflowY: isOverflowing ? 'auto' : 'hidden',
              fontFamily: 'var(--ac-font-body)',
              color: 'var(--ac-text)',
            }}
            placeholder={placeholder}
            rows={1}
            onInput={(event) => onUpdateModelValue?.((event.currentTarget as HTMLTextAreaElement).value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey
              ) {
                event.preventDefault();
                if (!isRequestActive && canSend && !sending) {
                  onSubmit?.();
                }
              }
            }}
            onPaste={(event) => {
              if (supportsImages) {
                const items = event.clipboardData?.items;
                if (items) {
                  for (const item of items) {
                    if (item.type.startsWith('image/')) {
                      onAttachmentPaste?.(event.nativeEvent);
                      return;
                    }
                  }
                }
              }
            }}
          />

          {enableFakeCaret ? (
            <FakeCaretOverlay textareaRef={textareaRef.current} enabled={true} value={modelValue} />
          ) : null}

          {showExpandButton ? (
            <button
              type="button"
              className="absolute top-2 right-2 p-1.5 transition-all hover:scale-105 cursor-pointer"
              style={{
                backgroundColor: 'var(--ac-surface-muted)',
                color: 'var(--ac-text)',
                border: 'var(--ac-border-width) solid var(--ac-border)',
                borderRadius: 'var(--ac-radius-button)',
              }}
              title={t('agentComposerExpandEditorTitle', 'Expand editor')}
              onClick={() => setIsDrawerOpen(true)}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
                />
              </svg>
            </button>
          ) : null}
        </div>

        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-1">
            {supportsImages ? (
              <button
                className="p-1.5 ac-btn"
                style={{ color: 'var(--ac-text-subtle)', borderRadius: 'var(--ac-radius-button)' }}
                data-tooltip={t('agentComposerAttachImageTooltip', 'Attach image (drag, paste, or click)')}
                onClick={() => onAttachmentAdd?.()}
                type="button"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
              </button>
            ) : null}

            {availableModels.length > 0 ? (
              <div className="relative" data-tooltip={t('agentComposerSwitchModelTooltip', 'Switch model')}>
                <span
                  ref={modelWidthRef}
                  className="invisible absolute whitespace-nowrap px-1.5 text-[10px]"
                  style={{ fontFamily: 'var(--ac-font-mono)' }}
                >
                  {selectedModelName}
                </span>
                <select
                  value={selectedModel}
                  className="py-0.5 text-[10px] border-none bg-transparent cursor-pointer appearance-none pr-4 pl-1.5"
                  style={{
                    color: 'var(--ac-text-muted)',
                    fontFamily: 'var(--ac-font-mono)',
                    width: modelSelectWidth,
                    borderRadius: 'var(--ac-radius-button)',
                  }}
                  onChange={(event) => onModelChange?.((event.currentTarget as HTMLSelectElement).value)}
                >
                  {availableModels.map((modelDefinition) => (
                    <option key={modelDefinition.id} value={modelDefinition.id}>
                      {modelDefinition.name}
                    </option>
                  ))}
                </select>
                <svg
                  className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none"
                  style={{ color: 'var(--ac-text-subtle)' }}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            ) : null}

            {isCodexEngine && availableReasoningEfforts && availableReasoningEfforts.length > 0 ? (
              <select
                value={reasoningEffort}
                className="px-1.5 py-0.5 text-[10px] border-none bg-transparent cursor-pointer"
                style={{
                  color: 'var(--ac-text-muted)',
                  fontFamily: 'var(--ac-font-mono)',
                  borderRadius: 'var(--ac-radius-button)',
                }}
                data-tooltip={t('agentComposerReasoningEffortTooltip', 'Reasoning effort')}
                onChange={(event) =>
                  onReasoningEffortChange?.(
                    (event.currentTarget as HTMLSelectElement).value as CodexReasoningEffort,
                  )
                }
              >
                {availableReasoningEfforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            ) : null}

            <button
              className="p-1 ac-btn"
              style={{ color: 'var(--ac-text-subtle)', borderRadius: 'var(--ac-radius-button)' }}
              data-tooltip={t('agentComposerResetConversationTooltip', 'Reset conversation')}
              onClick={handleReset}
              type="button"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>

            <button
              className="p-1 ac-btn"
              style={{ color: 'var(--ac-text-subtle)', borderRadius: 'var(--ac-radius-button)' }}
              data-tooltip={t('agentComposerSessionSettingsTooltip', 'Session settings')}
              onClick={() => onSessionSettings?.()}
              type="button"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
                />
              </svg>
            </button>

            <div className="text-[11px] ml-1 flex items-center gap-1" style={{ color: statusColor }}>
              {sending || isRequestActive ? (
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
                  style={{ backgroundColor: 'var(--ac-accent)' }}
                />
              ) : null}
              {statusText}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              className="p-1 transition-colors cursor-pointer"
              style={primaryActionButtonStyle}
              disabled={primaryActionDisabled}
              title={
                isRequestActive
                  ? t('agentComposerStopTitle', 'Stop')
                  : t('agentComposerSendTitle', 'Send')
              }
              aria-label={
                isRequestActive
                  ? t('agentComposerStopRequestAria', 'Stop request')
                  : t('agentComposerSendMessageAria', 'Send message')
              }
              onClick={handlePrimaryAction}
            >
              {isRequestActive ? (
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 10l7-7m0 0l7 7m-7-7v18" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      <ComposerDrawer
        open={isDrawerOpen}
        modelValue={modelValue}
        placeholder={placeholder}
        attachments={attachments}
        attachmentError={attachmentError}
        requestState={requestState}
        sending={sending}
        cancelling={cancelling}
        canCancel={canCancel}
        canSend={canSend}
        enableFakeCaret={enableFakeCaret}
        onClose={() => {
          setIsDrawerOpen(false);
          requestAnimationFrame(() => {
            textareaRef.current?.focus();
          });
        }}
        onUpdateModelValue={(value) => onUpdateModelValue?.(value)}
        onSubmit={handleSubmit}
        onCancel={() => onCancel?.()}
        onAttachmentRemove={(index) => onAttachmentRemove?.(index)}
        onPaste={(event) => {
          if (supportsImages) {
            const items = event.clipboardData?.items;
            if (items) {
              for (const item of items) {
                if (item.type.startsWith('image/')) {
                  onAttachmentPaste?.(event);
                  return;
                }
              }
            }
          }
        }}
        leftActions={
          <div className="flex items-center gap-1">
            {supportsImages ? (
              <button
                className="p-1.5 ac-btn"
                style={{ color: 'var(--ac-text-subtle)', borderRadius: 'var(--ac-radius-button)' }}
                data-tooltip={t('agentComposerAttachImageShortTooltip', 'Attach image')}
                onClick={() => onAttachmentAdd?.()}
                type="button"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
              </button>
            ) : null}

            {availableModels.length > 0 ? (
              <div className="relative" data-tooltip={t('agentComposerSwitchModelTooltip', 'Switch model')}>
                <select
                  value={selectedModel}
                  className="py-0.5 text-[10px] border-none bg-transparent cursor-pointer appearance-none pr-4 pl-1.5"
                  style={{
                    color: 'var(--ac-text-muted)',
                    fontFamily: 'var(--ac-font-mono)',
                    borderRadius: 'var(--ac-radius-button)',
                  }}
                  onChange={(event) => onModelChange?.((event.currentTarget as HTMLSelectElement).value)}
                >
                  {availableModels.map((modelDefinition) => (
                    <option key={modelDefinition.id} value={modelDefinition.id}>
                      {modelDefinition.name}
                    </option>
                  ))}
                </select>
                <svg
                  className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none"
                  style={{ color: 'var(--ac-text-subtle)' }}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            ) : null}

            <div className="text-[11px] ml-1 flex items-center gap-1" style={{ color: statusColor }}>
              {sending || isRequestActive ? (
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
                  style={{ backgroundColor: 'var(--ac-accent)' }}
                />
              ) : null}
              {statusText}
            </div>
          </div>
        }
      />
    </div>
  );
}
