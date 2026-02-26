import { useEffect, useMemo, useState } from 'react';
import type { SelectedElementSummary } from '@/common/web-editor-types';

type SelectionChipProps = {
  selected: SelectedElementSummary;
  onHoverStart?: (selected: SelectedElementSummary) => void;
  onHoverEnd?: (selected: SelectedElementSummary) => void;
};

function getChipTagName(selected: SelectedElementSummary): string {
  if (selected.tagName) {
    return selected.tagName.toLowerCase();
  }

  const label = (selected.label || '').trim();
  const match = label.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  return match?.[1]?.toLowerCase() || 'element';
}

export default function SelectionChip({ selected, onHoverStart, onHoverEnd }: SelectionChipProps) {
  const [isHovering, setIsHovering] = useState(false);

  useEffect(() => {
    return () => {
      if (isHovering) {
        onHoverEnd?.(selected);
      }
    };
  }, [isHovering, onHoverEnd, selected]);

  const chipTagName = useMemo(() => getChipTagName(selected), [selected]);

  return (
    <div
      className="relative inline-flex items-center gap-1.5 text-[11px] leading-none flex-shrink-0 select-none"
      style={{
        backgroundColor: isHovering ? 'var(--ac-hover-bg)' : 'var(--ac-surface)',
        border: `var(--ac-border-width) solid ${isHovering ? 'var(--ac-accent)' : 'var(--ac-border)'}`,
        borderRadius: 'var(--ac-radius-button)',
        boxShadow: isHovering ? 'var(--ac-shadow-card)' : 'none',
        color: 'var(--ac-text)',
        cursor: 'default',
      }}
      onMouseEnter={() => {
        setIsHovering(true);
        onHoverStart?.(selected);
      }}
      onMouseLeave={() => {
        setIsHovering(false);
        onHoverEnd?.(selected);
      }}
    >
      <span className="inline-flex items-center justify-center w-3.5 h-3.5" style={{ color: 'var(--ac-accent)' }}>
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"
          />
        </svg>
      </span>

      <span className="truncate max-w-[140px] px-1 py-0.5" style={{ fontFamily: 'var(--ac-font-mono)' }}>
        {chipTagName}
      </span>

      <span
        className="px-1 py-0.5 text-[9px] uppercase tracking-wider"
        style={{
          backgroundColor: 'var(--ac-accent)',
          color: 'var(--ac-accent-contrast)',
          borderRadius: 'var(--ac-radius-button)',
          fontFamily: 'var(--ac-font-mono)',
          fontWeight: '600',
        }}
      >
        sel
      </span>
    </div>
  );
}
