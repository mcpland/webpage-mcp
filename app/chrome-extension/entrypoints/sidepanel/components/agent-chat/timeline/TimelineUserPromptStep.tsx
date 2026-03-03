import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resolveAgentAttachmentUrl } from '@/utils/agent-attachment-url';
import { getMessage } from '@/utils/i18n';

import type { TimelineItem } from '../../../composables/useAgentThreads';
import MarkdownRenderer from './MarkdownRenderer';
import './timeline-markdown.css';

type UserPromptItem = Extract<TimelineItem, { kind: 'user_prompt' }>;
type UserPromptAttachment = UserPromptItem['attachments'][number];

type TimelineUserPromptStepProps = {
  item: UserPromptItem;
  serverPort?: number | null;
};

export default function TimelineUserPromptStep({
  item,
  serverPort: _serverPort,
}: TimelineUserPromptStepProps) {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [overlayTarget, setOverlayTarget] = useState<Element | null>(null);
  const [viewerAttachment, setViewerAttachment] = useState<UserPromptAttachment | null>(null);
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});

  const hasText = (item.text || '').trim().length > 0;

  const viewerUrl = useMemo(() => {
    if (!viewerAttachment) {
      return null;
    }
    const path = viewerAttachment.urlPath.startsWith('/')
      ? viewerAttachment.urlPath
      : `/${viewerAttachment.urlPath}`;
    return attachmentUrls[path] || null;
  }, [attachmentUrls, viewerAttachment]);

  function getAttachmentUrl(attachment: UserPromptAttachment): string | null {
    const path = attachment.urlPath.startsWith('/') ? attachment.urlPath : `/${attachment.urlPath}`;
    return attachmentUrls[path] || null;
  }

  useEffect(() => {
    const target =
      rootRef.current?.closest('.agent-theme') ?? rootRef.current?.ownerDocument?.body ?? null;
    setOverlayTarget(target);
  }, []);

  useEffect(() => {
    if (!viewerAttachment) {
      return;
    }

    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setViewerAttachment(null);
      }
    };

    document.addEventListener('keydown', onKeydown);
    return () => {
      document.removeEventListener('keydown', onKeydown);
    };
  }, [viewerAttachment]);

  useEffect(() => {
    let cancelled = false;
    const missing = item.attachments.filter((attachment) => {
      const path = attachment.urlPath.startsWith('/') ? attachment.urlPath : `/${attachment.urlPath}`;
      return !attachmentUrls[path];
    });

    if (missing.length === 0) {
      return;
    }

    void (async () => {
      for (const attachment of missing) {
        const path = attachment.urlPath.startsWith('/') ? attachment.urlPath : `/${attachment.urlPath}`;
        const url = await resolveAgentAttachmentUrl(path);
        if (!url || cancelled) {
          continue;
        }
        setAttachmentUrls((current) => {
          if (current[path]) {
            return current;
          }
          return {
            ...current,
            [path]: url,
          };
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attachmentUrls, item.attachments]);

  return (
    <div ref={rootRef} className="py-1 space-y-2">
      {hasText ? (
        <MarkdownRenderer
          className="timeline-markdown-content text-sm leading-relaxed"
          content={item.text}
          maxLiveNodes={0}
          renderBatchSize={16}
          renderBatchDelay={8}
        />
      ) : null}

      {!hasText && item.attachments.length > 0 ? (
        <span className="text-xs italic" style={{ color: 'var(--ac-text-subtle)' }}>
          {t('agentSentImagesSummary', 'Sent {0} image{1}', [
            String(item.attachments.length),
            item.attachments.length === 1 ? '' : 's',
          ])}
        </span>
      ) : null}

      {item.attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2 mt-2">
          {item.attachments.map((attachment) => {
            const url = getAttachmentUrl(attachment);
            return (
              <button
                key={`${attachment.messageId}:${attachment.index}`}
                type="button"
                className="relative group w-16 h-16 rounded-lg overflow-hidden transition-opacity hover:opacity-90 cursor-pointer"
                style={{
                  backgroundColor: 'var(--ac-surface-muted)',
                  border: 'var(--ac-border-width) solid var(--ac-border)',
                }}
                title={attachment.originalName}
                onClick={() => {
                  setViewerAttachment(attachment);
                }}
              >
                {url ? (
                  <img
                    src={url}
                    alt={attachment.originalName}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div
                    className="w-full h-full flex items-center justify-center"
                    style={{ color: 'var(--ac-text-subtle)' }}
                    title={t('agentServerNotReadyTitle', 'Server not ready')}
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

                <div
                  className="absolute bottom-0 left-0 right-0 px-0.5 py-0.5 text-[8px] truncate opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{
                    backgroundColor: 'rgba(0,0,0,0.6)',
                    color: 'white',
                  }}
                >
                  {attachment.originalName}
                </div>
              </button>
            );
          })}
        </div>
      ) : null}

      {viewerAttachment && overlayTarget
        ? createPortal(
            <div
              className="fixed inset-0 z-50 flex items-center justify-center"
              role="dialog"
              aria-modal="true"
              aria-label={t('agentImagePreviewAria', 'Image preview')}
            >
              <div className="absolute inset-0 bg-black/60" onClick={() => setViewerAttachment(null)} />
              <div
                className="relative max-w-[92vw] max-h-[92vh] overflow-hidden"
                style={{
                  backgroundColor: 'var(--ac-surface, #ffffff)',
                  border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
                  borderRadius: 'var(--ac-radius-card, 12px)',
                  boxShadow: 'var(--ac-shadow-float, 0 4px 20px -2px rgba(0,0,0,0.2))',
                }}
              >
                <button
                  type="button"
                  className="absolute top-2 right-2 p-1 rounded-full transition-colors hover:bg-black/20 cursor-pointer"
                  style={{ color: 'white' }}
                  aria-label={t('agentImagePreviewCloseAria', 'Close image preview')}
                  onClick={() => setViewerAttachment(null)}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>

                {viewerUrl ? (
                  <img
                    src={viewerUrl}
                    alt={viewerAttachment.originalName}
                    className="block max-w-[92vw] max-h-[92vh] object-contain"
                  />
                ) : (
                  <div className="p-6 text-sm" style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                    {t(
                      'agentServerNotReadyMissingPort',
                      'Agent server not ready (missing server port).',
                    )}
                  </div>
                )}
              </div>
            </div>,
            overlayTarget,
          )
        : null}
    </div>
  );
}
