import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ThreadHeader, WebEditorApplyMeta } from '../../composables';

type ApplyMessageChipProps = {
  header: ThreadHeader;
};

const HIDE_DELAY_MS = 180;

export default function ApplyMessageChip({ header }: ApplyMessageChipProps) {
  const chipRef = useRef<HTMLDivElement | null>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [chipRect, setChipRect] = useState<DOMRect | null>(null);
  const [tooltipTarget, setTooltipTarget] = useState<Element | null>(null);
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const [isHoveringChip, setIsHoveringChip] = useState(false);
  const [isHoveringTooltip, setIsHoveringTooltip] = useState(false);

  const webEditorApply = header.webEditorApply as WebEditorApplyMeta | undefined;
  const displayText = header.displayText || 'Apply changes';
  const elementCount = webEditorApply?.elementCount;
  const elementLabels = webEditorApply?.elementLabels || [];
  const pageUrl = webEditorApply?.pageUrl;

  const pageHostname = useMemo(() => {
    if (!pageUrl) {
      return '';
    }

    try {
      return new URL(pageUrl).hostname;
    } catch {
      return pageUrl;
    }
  }, [pageUrl]);

  const displayLabels = elementLabels.slice(0, 4);
  const remainingCount = Math.max(0, elementLabels.length - 4);

  const truncatedPrompt = useMemo(() => {
    const full = header.fullContent;
    const maxLen = 500;
    if (full.length <= maxLen) {
      return full;
    }
    return `${full.slice(0, maxLen)}...`;
  }, [header.fullContent]);

  const tooltipPositionStyle = useMemo(() => {
    const rect = chipRect;
    if (!rect) {
      return {
        opacity: 0,
        zIndex: 9999,
      } as const;
    }

    const tooltipWidth = 360;
    const gap = 8;
    const padding = 8;
    const viewportWidth = window.innerWidth;
    let left = rect.left;

    if (left + tooltipWidth > viewportWidth - padding) {
      left = viewportWidth - tooltipWidth - padding;
    }
    if (left < padding) {
      left = padding;
    }

    return {
      left: `${left}px`,
      top: `${rect.bottom + gap}px`,
      zIndex: 9999,
    } as const;
  }, [chipRect]);

  function updateChipRect(): void {
    if (chipRef.current) {
      setChipRect(chipRef.current.getBoundingClientRect());
    }
  }

  function clearHideTimeout(): void {
    if (hideTimeoutRef.current !== null) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }

  function openTooltip(): void {
    clearHideTimeout();
    setIsTooltipOpen(true);
  }

  function scheduleCloseTooltip(): void {
    clearHideTimeout();
    hideTimeoutRef.current = setTimeout(() => {
      if (!isHoveringChip && !isHoveringTooltip) {
        setIsTooltipOpen(false);
      }
    }, HIDE_DELAY_MS);
  }

  useEffect(() => {
    const target = chipRef.current?.closest('.agent-theme') ?? chipRef.current?.ownerDocument?.body ?? null;
    setTooltipTarget(target);
  }, []);

  useEffect(() => {
    return () => {
      clearHideTimeout();
    };
  }, []);

  useEffect(() => {
    if (!isTooltipOpen) {
      return;
    }

    const onResize = () => updateChipRect();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [isTooltipOpen]);

  return (
    <>
      <div
        ref={chipRef}
        className="inline-flex items-center gap-1.5 text-sm leading-none cursor-default"
        onMouseEnter={() => {
          updateChipRect();
          setIsHoveringChip(true);
          openTooltip();
        }}
        onMouseLeave={() => {
          setIsHoveringChip(false);
          scheduleCloseTooltip();
        }}
      >
        <span
          className="inline-flex items-center justify-center w-5 h-5 rounded"
          style={{
            backgroundColor: 'var(--ac-accent)',
            color: 'var(--ac-accent-contrast)',
          }}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
            />
          </svg>
        </span>

        <span className="font-medium" style={{ color: 'var(--ac-text)' }}>
          {displayText}
        </span>

        {elementCount ? (
          <span
            className="px-1.5 py-0.5 text-[10px] font-medium rounded"
            style={{
              backgroundColor: 'var(--ac-surface-muted)',
              color: 'var(--ac-text-muted)',
            }}
          >
            {elementCount} element{elementCount === 1 ? '' : 's'}
          </span>
        ) : null}

        <svg
          className="w-3.5 h-3.5 opacity-50"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          style={{ color: 'var(--ac-text-subtle)' }}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </div>

      {isTooltipOpen && tooltipTarget
        ? createPortal(
            <div
              className="fixed"
              style={tooltipPositionStyle}
              role="tooltip"
              onMouseEnter={() => {
                setIsHoveringTooltip(true);
                openTooltip();
              }}
              onMouseLeave={() => {
                setIsHoveringTooltip(false);
                scheduleCloseTooltip();
              }}
            >
              <div
                className="px-3 py-2.5 text-[11px] space-y-2"
                style={{
                  backgroundColor: 'var(--ac-surface)',
                  border: 'var(--ac-border-width) solid var(--ac-border)',
                  borderRadius: 'var(--ac-radius-card)',
                  boxShadow: 'var(--ac-shadow-float)',
                  color: 'var(--ac-text)',
                  minWidth: '280px',
                  maxWidth: '400px',
                }}
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="font-semibold" style={{ color: 'var(--ac-text)' }}>
                    Web Editor Apply
                  </span>
                  {pageUrl ? (
                    <span
                      className="text-[10px] truncate max-w-[200px]"
                      style={{ color: 'var(--ac-text-subtle)', fontFamily: 'var(--ac-font-mono)' }}
                    >
                      {pageHostname}
                    </span>
                  ) : null}
                </div>

                {elementLabels.length > 0 ? (
                  <div className="space-y-1">
                    <div className="text-[10px]" style={{ color: 'var(--ac-text-muted)' }}>
                      Modified elements:
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {displayLabels.map((label, idx) => (
                        <span
                          key={`${idx}-${label}`}
                          className="px-1.5 py-0.5 text-[10px] rounded"
                          style={{
                            backgroundColor: 'var(--ac-surface-muted)',
                            color: 'var(--ac-text)',
                            fontFamily: 'var(--ac-font-mono)',
                          }}
                        >
                          {label}
                        </span>
                      ))}
                      {remainingCount > 0 ? (
                        <span
                          className="px-1.5 py-0.5 text-[10px] rounded"
                          style={{ color: 'var(--ac-text-subtle)' }}
                        >
                          +{remainingCount} more
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className="space-y-1">
                  <div className="text-[10px]" style={{ color: 'var(--ac-text-muted)' }}>
                    Prompt preview:
                  </div>
                  <pre
                    className="text-[10px] max-h-[100px] overflow-auto whitespace-pre-wrap break-all p-2 rounded"
                    style={{
                      backgroundColor: 'var(--ac-code-bg)',
                      color: 'var(--ac-code-text)',
                      fontFamily: 'var(--ac-font-mono)',
                      border: 'var(--ac-border-width) solid var(--ac-code-border)',
                    }}
                  >
                    {truncatedPrompt}
                  </pre>
                </div>
              </div>
            </div>,
            tooltipTarget,
          )
        : null}
    </>
  );
}
