import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { ElementChangeSummary, WebEditorElementKey } from '@/common/web-editor-types';

type ElementChipProps = {
  element: ElementChangeSummary;
  excluded: boolean;
  selected?: boolean;
  scrollResizeTrigger?: number;
  onToggleExclude?: (elementKey: WebEditorElementKey) => void;
  onRevert?: (elementKey: WebEditorElementKey) => void;
  onHoverStart?: (element: ElementChangeSummary) => void;
  onHoverEnd?: (element: ElementChangeSummary) => void;
};

function formatListWithLimit(items: readonly string[], limit: number): string {
  const cleaned = items.map((s) => String(s ?? '').trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  const visible = cleaned.slice(0, limit);
  const overflow = cleaned.length - visible.length;
  return overflow > 0 ? `${visible.join(', ')} (+${overflow} more)` : visible.join(', ');
}

function getChipTagName(label: string): string {
  const match = (label || '').trim().match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  return match?.[1]?.toLowerCase() || 'element';
}

function TypeIcon({ type }: { type: ElementChangeSummary['type'] }) {
  if (type === 'style') {
    return (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
        />
      </svg>
    );
  }

  if (type === 'text') {
    return (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h10M4 18h12" />
      </svg>
    );
  }

  if (type === 'class') {
    return (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"
        />
      </svg>
    );
  }

  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
      />
    </svg>
  );
}

export default function ElementChip({
  element,
  excluded,
  selected = false,
  scrollResizeTrigger,
  onToggleExclude,
  onRevert,
  onHoverStart,
  onHoverEnd,
}: ElementChipProps) {
  const chipRef = useRef<HTMLDivElement | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [chipRect, setChipRect] = useState<DOMRect | null>(null);
  const [tooltipTarget, setTooltipTarget] = useState<Element | null>(null);

  const showTooltip = isHovering || isFocused;
  const chipTagName = useMemo(() => getChipTagName(element.label || ''), [element.label]);

  const styleDetailsText = useMemo(() => {
    const details = element.changes.style?.details;
    return details?.length ? formatListWithLimit(details, 6) : '';
  }, [element.changes.style]);

  const classAddedText = useMemo(() => {
    const added = element.changes.class?.added;
    return added?.length ? formatListWithLimit(added, 4) : '';
  }, [element.changes.class]);

  const classRemovedText = useMemo(() => {
    const removed = element.changes.class?.removed;
    return removed?.length ? formatListWithLimit(removed, 4) : '';
  }, [element.changes.class]);

  const hasClassChanges = Boolean(classAddedText || classRemovedText);

  function updateRect(): void {
    if (chipRef.current) {
      setChipRect(chipRef.current.getBoundingClientRect());
    }
  }

  useEffect(() => {
    if (chipRef.current) {
      const target = chipRef.current.closest('.agent-theme');
      setTooltipTarget(target);
    }
  }, []);

  useEffect(() => {
    if (showTooltip) {
      updateRect();
    }
  }, [showTooltip, scrollResizeTrigger]);

  useEffect(() => {
    return () => {
      if (isHovering) {
        onHoverEnd?.(element);
      }
    };
  }, [isHovering, onHoverEnd, element]);

  const ariaLabel = `${element.label} (${element.type} change, ${excluded ? 'excluded' : 'included'}). Click to toggle.`;

  const borderColor = selected
    ? 'var(--ac-accent)'
    : showTooltip
      ? 'var(--ac-border-strong)'
      : 'var(--ac-border)';

  const tooltipPositionStyle: CSSProperties = (() => {
    if (!chipRect) {
      return { opacity: 0, zIndex: 9999 };
    }

    const tooltipWidth = 300;
    const gap = 8;
    const viewportWidth = window.innerWidth;
    const padding = 8;
    let left = chipRect.left + chipRect.width / 2 - tooltipWidth / 2;

    if (left < padding) {
      left = padding;
    } else if (left + tooltipWidth > viewportWidth - padding) {
      left = viewportWidth - tooltipWidth - padding;
    }

    return {
      left: `${left}px`,
      top: `${chipRect.top - gap}px`,
      transform: 'translateY(-100%)',
      zIndex: 9999,
    };
  })();

  const tooltip =
    showTooltip && tooltipTarget
      ? createPortal(
          <div className="fixed pointer-events-none" style={tooltipPositionStyle} role="tooltip">
            <div
              className="px-3 py-2 text-[11px] space-y-1.5"
              style={{
                backgroundColor: 'var(--ac-surface)',
                border: 'var(--ac-border-width) solid var(--ac-border)',
                borderRadius: 'var(--ac-radius-inner)',
                boxShadow: 'var(--ac-shadow-float)',
                color: 'var(--ac-text)',
                minWidth: '240px',
                maxWidth: '360px',
              }}
            >
              <div className="font-medium truncate max-w-[320px]" style={{ fontFamily: 'var(--ac-font-mono)' }}>
                {element.fullLabel || element.label}
              </div>

              <div className="text-[10px] flex items-center gap-2" style={{ color: 'var(--ac-text-subtle)' }}>
                <span style={{ fontFamily: 'var(--ac-font-mono)' }}>{element.type}</span>
                <span className="opacity-50">&middot;</span>
                <span>{excluded ? 'Excluded' : 'Included'}</span>
                <span className="opacity-50">&middot;</span>
                <span>
                  {element.transactionIds.length} change{element.transactionIds.length !== 1 ? 's' : ''}
                </span>
              </div>

              {element.changes.style ? (
                <div className="text-[10px] space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">Style</span>
                    <span style={{ fontFamily: 'var(--ac-font-mono)', color: 'var(--ac-text-muted)' }}>
                      {element.changes.style.added > 0 ? (
                        <span style={{ color: 'var(--ac-success, #10b981)' }}>+{element.changes.style.added}</span>
                      ) : null}
                      {element.changes.style.modified > 0 ? (
                        <>
                          {element.changes.style.added > 0 ? <span className="mx-0.5">/</span> : null}
                          <span style={{ color: 'var(--ac-warning, #f59e0b)' }}>~{element.changes.style.modified}</span>
                        </>
                      ) : null}
                      {element.changes.style.removed > 0 ? (
                        <>
                          {element.changes.style.added > 0 || element.changes.style.modified > 0 ? (
                            <span className="mx-0.5">/</span>
                          ) : null}
                          <span style={{ color: 'var(--ac-danger, #ef4444)' }}>-{element.changes.style.removed}</span>
                        </>
                      ) : null}
                    </span>
                  </div>
                  {styleDetailsText ? (
                    <div style={{ fontFamily: 'var(--ac-font-mono)', color: 'var(--ac-text-subtle)' }}>
                      {styleDetailsText}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {element.changes.text ? (
                <div className="text-[10px] space-y-0.5">
                  <div className="font-medium">Text</div>
                  <div className="flex items-start gap-2">
                    <span className="opacity-60 w-10 flex-shrink-0">before</span>
                    <code
                      className="truncate max-w-[260px]"
                      style={{
                        fontFamily: 'var(--ac-font-mono)',
                        backgroundColor: 'var(--ac-surface-muted)',
                        borderRadius: 'var(--ac-radius-button)',
                        padding: '1px 4px',
                        color: 'var(--ac-text)',
                      }}
                    >
                      {element.changes.text.beforePreview || '(empty)'}
                    </code>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="opacity-60 w-10 flex-shrink-0">after</span>
                    <code
                      className="truncate max-w-[260px]"
                      style={{
                        fontFamily: 'var(--ac-font-mono)',
                        backgroundColor: 'var(--ac-surface-muted)',
                        borderRadius: 'var(--ac-radius-button)',
                        padding: '1px 4px',
                        color: 'var(--ac-text)',
                      }}
                    >
                      {element.changes.text.afterPreview || '(empty)'}
                    </code>
                  </div>
                </div>
              ) : null}

              {element.changes.class && hasClassChanges ? (
                <div className="text-[10px] space-y-0.5">
                  <div className="font-medium">Class</div>
                  {classAddedText ? (
                    <div style={{ fontFamily: 'var(--ac-font-mono)', color: 'var(--ac-text-subtle)' }}>
                      <span style={{ color: 'var(--ac-success, #10b981)' }}>+</span> {classAddedText}
                    </div>
                  ) : null}
                  {classRemovedText ? (
                    <div style={{ fontFamily: 'var(--ac-font-mono)', color: 'var(--ac-text-subtle)' }}>
                      <span style={{ color: 'var(--ac-danger, #ef4444)' }}>-</span> {classRemovedText}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>,
          tooltipTarget,
        )
      : null;

  return (
    <>
      <div
        ref={chipRef}
        className="relative inline-flex items-center gap-1.5 text-[11px] leading-none flex-shrink-0 select-none transition-colors"
        style={{
          backgroundColor: showTooltip ? 'var(--ac-hover-bg)' : 'var(--ac-surface)',
          border: `var(--ac-border-width) solid ${borderColor}`,
          borderRadius: 'var(--ac-radius-button)',
          boxShadow: showTooltip ? 'var(--ac-shadow-card)' : 'none',
          color: excluded ? 'var(--ac-text-subtle)' : 'var(--ac-text-muted)',
          opacity: excluded ? 0.7 : 1,
        }}
        onMouseEnter={() => {
          updateRect();
          setIsHovering(true);
          onHoverStart?.(element);
        }}
        onMouseLeave={() => {
          setIsHovering(false);
          onHoverEnd?.(element);
        }}
      >
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2 py-1 bg-transparent border-none cursor-pointer"
          aria-pressed={!excluded}
          aria-label={ariaLabel}
          onClick={() => onToggleExclude?.(element.elementKey)}
          onFocus={() => {
            updateRect();
            setIsFocused(true);
          }}
          onBlur={() => setIsFocused(false)}
        >
          <span
            className="inline-flex items-center justify-center w-3.5 h-3.5"
            style={{ color: excluded ? 'var(--ac-text-subtle)' : 'var(--ac-accent)' }}
          >
            <TypeIcon type={element.type} />
          </span>

          <span className="truncate max-w-[140px]" style={{ fontFamily: 'var(--ac-font-mono)' }}>
            {chipTagName}
          </span>

          <span
            className="ml-0.5 px-1 py-0.5 text-[9px] uppercase tracking-wider"
            style={{
              backgroundColor: excluded ? 'var(--ac-surface-muted)' : 'var(--ac-accent)',
              color: excluded ? 'var(--ac-text-subtle)' : 'var(--ac-accent-contrast)',
              borderRadius: 'var(--ac-radius-button)',
              fontFamily: 'var(--ac-font-mono)',
              fontWeight: 600,
            }}
          >
            {excluded ? 'ex' : 'in'}
          </span>
        </button>

        <button
          type="button"
          className="flex items-center justify-center w-4 h-4 -ml-1 mr-1 rounded-full transition-colors cursor-pointer"
          style={{
            backgroundColor: isHovering ? 'var(--ac-danger, #ef4444)' : 'var(--ac-surface-muted)',
            color: isHovering ? 'white' : 'var(--ac-text-subtle)',
            opacity: isHovering ? 1 : 0,
            pointerEvents: isHovering ? 'auto' : 'none',
          }}
          aria-label={`Revert changes to ${element.label}`}
          title={`Revert all changes to ${element.label}`}
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            onRevert?.(element.elementKey);
          }}
        >
          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {tooltip}
    </>
  );
}
