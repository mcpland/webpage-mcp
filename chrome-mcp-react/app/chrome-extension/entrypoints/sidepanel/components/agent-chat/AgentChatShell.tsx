import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentUsageStats } from 'webpage-mcp-shared';

type AgentChatShellProps = {
  errorMessage?: string | null;
  usage?: AgentUsageStats | null;
  footerLabel?: string;
  header?: ReactNode;
  content?: ReactNode;
  composer?: ReactNode;
  onErrorDismiss?: () => void;
};

const SCROLL_THRESHOLD = 150;

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return count.toString();
}

function isNearBottom(el: HTMLElement): boolean {
  const { scrollTop, scrollHeight, clientHeight } = el;
  return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD;
}

export default function AgentChatShell({
  errorMessage,
  usage,
  footerLabel,
  header,
  content,
  composer,
  onErrorDismiss,
}: AgentChatShellProps) {
  const contentRef = useRef<HTMLElement | null>(null);
  const contentSlotRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);

  const [composerHeight, setComposerHeight] = useState(120);
  const isUserScrolledUpRef = useRef(false);
  const scrollScheduledRef = useRef(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (!contentRef.current) {
      return;
    }

    contentRef.current.scrollTo({
      top: contentRef.current.scrollHeight,
      behavior,
    });
  }, []);

  const maybeAutoScroll = useCallback(() => {
    if (scrollScheduledRef.current || isUserScrolledUpRef.current || !contentRef.current) {
      return;
    }

    scrollScheduledRef.current = true;
    requestAnimationFrame(() => {
      scrollScheduledRef.current = false;
      if (!isUserScrolledUpRef.current) {
        scrollToBottom('auto');
      }
    });
  }, [scrollToBottom]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setComposerHeight(entry.contentRect.height + 24);
      }
      maybeAutoScroll();
    });
    observer.observe(composer);

    return () => observer.disconnect();
  }, [maybeAutoScroll]);

  useEffect(() => {
    const contentSlot = contentSlotRef.current;
    if (!contentSlot) {
      return;
    }

    const observer = new ResizeObserver(() => {
      maybeAutoScroll();
    });
    observer.observe(contentSlot);

    return () => observer.disconnect();
  }, [maybeAutoScroll]);

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      <header
        className="flex-none px-5 py-3 flex items-center justify-between z-20"
        style={{
          backgroundColor: 'var(--ac-header-bg)',
          borderBottom: 'var(--ac-border-width) solid var(--ac-header-border)',
          backdropFilter: 'blur(8px)',
        }}
      >
        {header}
      </header>

      <main
        ref={contentRef}
        className="flex-1 overflow-y-auto ac-scroll"
        style={{
          paddingBottom: `${composerHeight}px`,
        }}
        onScroll={() => {
          if (!contentRef.current) {
            return;
          }

          isUserScrolledUpRef.current = !isNearBottom(contentRef.current);
        }}
      >
        <div ref={contentSlotRef}>{content}</div>
      </main>

      <footer
        ref={composerRef}
        className="flex-none px-5 pb-5 pt-2"
        style={{
          background: 'linear-gradient(to top, var(--ac-bg), var(--ac-bg), transparent)',
        }}
      >
        {errorMessage ? (
          <div
            className="mb-2 px-4 py-2 text-xs rounded-lg flex items-start gap-2"
            style={{
              backgroundColor: 'var(--ac-diff-del-bg)',
              color: 'var(--ac-danger)',
              border: 'var(--ac-border-width) solid var(--ac-diff-del-border)',
              borderRadius: 'var(--ac-radius-inner)',
            }}
          >
            <div
              className="min-w-0 flex-1 whitespace-pre-wrap break-all ac-scroll"
              style={{ maxHeight: '30vh', overflowY: 'auto', overflowWrap: 'anywhere' }}
            >
              {errorMessage}
            </div>

            <button
              type="button"
              className="p-1 flex-shrink-0 ac-btn ac-focus-ring cursor-pointer"
              style={{
                color: 'var(--ac-danger)',
                borderRadius: 'var(--ac-radius-button)',
              }}
              aria-label="Dismiss error"
              title="Dismiss"
              onClick={onErrorDismiss}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ) : null}

        {composer}

        <div
          className="text-[10px] text-center mt-2 font-medium tracking-wide flex items-center justify-center gap-2"
          style={{ color: 'var(--ac-text-subtle)' }}
        >
          {usage ? (
            <>
              <span title={`Input: ${usage.inputTokens.toLocaleString()}, Output: ${usage.outputTokens.toLocaleString()}`}>
                {formatTokens(usage.inputTokens + usage.outputTokens)} tokens
              </span>
              <span className="opacity-50">·</span>
              <span title={`Duration: ${(usage.durationMs / 1000).toFixed(1)}s, Turns: ${usage.numTurns}`}>
                ${usage.totalCostUsd.toFixed(4)}
              </span>
              <span className="opacity-50">·</span>
            </>
          ) : null}
          <span>{footerLabel || 'Agent Preview'}</span>
        </div>
      </footer>
    </div>
  );
}
