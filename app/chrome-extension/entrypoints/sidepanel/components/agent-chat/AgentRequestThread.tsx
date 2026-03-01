import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AttachmentMetadata } from 'webpage-mcp-shared';
import { resolveAgentAttachmentUrl } from '@/utils/agent-attachment-url';

import type { AgentThread } from '../../composables/useAgentThreads';
import ApplyMessageChip from './ApplyMessageChip';
import AgentTimeline from './AgentTimeline';

type AgentRequestThreadProps = {
  thread: AgentThread;
  serverPort?: number | null;
};

export default function AgentRequestThread({ thread, serverPort: _serverPort }: AgentRequestThreadProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [overlayTarget, setOverlayTarget] = useState<Element | null>(null);
  const [viewerAttachment, setViewerAttachment] = useState<AttachmentMetadata | null>(null);
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});

  const viewerUrl = useMemo(() => {
    if (!viewerAttachment) {
      return null;
    }
    const path = viewerAttachment.urlPath.startsWith('/')
      ? viewerAttachment.urlPath
      : `/${viewerAttachment.urlPath}`;
    return attachmentUrls[path] || null;
  }, [attachmentUrls, viewerAttachment]);

  function getAttachmentUrl(attachment: AttachmentMetadata): string | null {
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
    const missing = thread.attachments.filter((attachment) => {
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
  }, [attachmentUrls, thread.attachments]);

  return (
    <div ref={rootRef} className="group">
      <div className="mb-4">
        <div className="flex justify-between items-start">
          {thread.header?.webEditorApply && thread.header ? (
            <ApplyMessageChip header={thread.header} />
          ) : (
            <h2
              className="text-lg font-medium leading-snug"
              style={{
                color: 'var(--ac-text)',
              }}
            >
              {thread.title}
            </h2>
          )}

          <button
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 cursor-pointer"
            style={{ color: 'var(--ac-text-subtle)' }}
            title="Edit (coming soon)"
            type="button"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
              />
            </svg>
          </button>
        </div>

        {thread.attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 mt-3">
            {thread.attachments.map((attachment) => {
              const url = getAttachmentUrl(attachment);
              return (
                <button
                  key={`${attachment.messageId}:${attachment.index}`}
                  type="button"
                  className="relative group/thumb w-16 h-16 rounded-lg overflow-hidden transition-opacity hover:opacity-90 cursor-pointer"
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
                      title="Server not ready"
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
                    className="absolute bottom-0 left-0 right-0 px-0.5 py-0.5 text-[8px] truncate opacity-0 group-hover/thumb:opacity-100 transition-opacity"
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
      </div>

      <AgentTimeline items={thread.items} state={thread.state} serverPort={_serverPort} />

      {viewerAttachment && overlayTarget
        ? createPortal(
            <div
              className="fixed inset-0 z-50 flex items-center justify-center"
              role="dialog"
              aria-modal="true"
              aria-label="Image preview"
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
                  aria-label="Close image preview"
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
                    Agent server not ready (missing server port).
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
