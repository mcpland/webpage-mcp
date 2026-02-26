import { useMemo, useState } from 'react';

import type { TimelineItem } from '../../../composables/useAgentThreads';

type TimelineToolResultCardStepProps = {
  item: Extract<TimelineItem, { kind: 'tool_result' }>;
};

const MAX_LINES = 10;
const MAX_CHARS = 500;

export default function TimelineToolResultCardStep({ item }: TimelineToolResultCardStepProps) {
  const [expanded, setExpanded] = useState(false);

  const labelColor = item.isError
    ? 'var(--ac-danger)'
    : item.tool.kind === 'edit'
      ? 'var(--ac-accent)'
      : 'var(--ac-success)';

  const hasDiffStats = useMemo(() => {
    const stats = item.tool.diffStats;
    if (!stats) {
      return false;
    }

    return (
      stats.addedLines !== undefined ||
      stats.deletedLines !== undefined ||
      stats.totalLines !== undefined
    );
  }, [item.tool.diffStats]);

  const showFilePath = Boolean(
    item.tool.filePath && item.tool.filePath !== item.tool.title && !item.tool.title.includes('/'),
  );

  const showCard =
    (item.tool.kind === 'edit' && Boolean(item.tool.files?.length)) ||
    (item.tool.kind === 'run' && Boolean(item.tool.details)) ||
    Boolean(item.tool.details);

  const editFiles = item.tool.files ?? [];

  const isDetailsTruncated = useMemo(() => {
    const details = item.tool.details ?? '';
    const lines = details.split('\n');
    return lines.length > MAX_LINES || details.length > MAX_CHARS;
  }, [item.tool.details]);

  const truncatedDetails = useMemo(() => {
    const details = item.tool.details ?? '';
    if (expanded) {
      return details;
    }

    const lines = details.split('\n');
    if (lines.length > MAX_LINES) {
      return lines.slice(0, MAX_LINES).join('\n');
    }

    if (details.length > MAX_CHARS) {
      return details.slice(0, MAX_CHARS);
    }

    return details;
  }, [expanded, item.tool.details]);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span
          className="text-[11px] font-bold uppercase tracking-wider w-8 flex-shrink-0"
          style={{ color: labelColor }}
        >
          {item.tool.label}
        </span>

        <code
          className="text-xs font-semibold"
          style={{
            fontFamily: 'var(--ac-font-mono)',
            color: 'var(--ac-text)',
          }}
          title={item.tool.filePath}
        >
          {item.tool.title}
        </code>

        {hasDiffStats ? (
          <span
            className="text-[10px] px-1.5 py-0.5"
            style={{
              backgroundColor: 'var(--ac-chip-bg)',
              color: 'var(--ac-text-muted)',
              fontFamily: 'var(--ac-font-mono)',
              borderRadius: 'var(--ac-radius-button)',
            }}
          >
            {item.tool.diffStats?.addedLines ? (
              <span className="text-green-600 dark:text-green-400">+{item.tool.diffStats.addedLines}</span>
            ) : null}
            {item.tool.diffStats?.addedLines && item.tool.diffStats?.deletedLines ? <span>/</span> : null}
            {item.tool.diffStats?.deletedLines ? (
              <span className="text-red-600 dark:text-red-400">-{item.tool.diffStats.deletedLines}</span>
            ) : null}
            {!item.tool.diffStats?.addedLines &&
            !item.tool.diffStats?.deletedLines &&
            item.tool.diffStats?.totalLines ? (
              <span>{item.tool.diffStats.totalLines} lines</span>
            ) : null}
          </span>
        ) : null}
      </div>

      {showFilePath ? (
        <div
          className="text-[10px] pl-10 truncate"
          style={{ color: 'var(--ac-text-subtle)' }}
          title={item.tool.filePath}
        >
          {item.tool.filePath}
        </div>
      ) : null}

      {showCard ? (
        <div
          className="overflow-hidden text-xs leading-5"
          style={{
            fontFamily: 'var(--ac-font-mono)',
            border: 'var(--ac-border-width) solid var(--ac-code-border)',
            boxShadow: 'var(--ac-shadow-card)',
            borderRadius: 'var(--ac-radius-inner)',
          }}
        >
          {item.tool.kind === 'edit' && editFiles.length ? (
            <>
              {editFiles.slice(0, 5).map((file, idx) => (
                <div
                  key={file}
                  className="px-3 py-1"
                  style={{
                    backgroundColor: 'var(--ac-surface)',
                    borderBottom:
                      idx === Math.min(editFiles.length, 5) - 1
                        ? 'none'
                        : 'var(--ac-border-width) solid var(--ac-border)',
                    color: 'var(--ac-text-muted)',
                  }}
                >
                  {file}
                </div>
              ))}
              {editFiles.length > 5 ? (
                <div
                  className="px-3 py-1 text-[10px]"
                  style={{
                    backgroundColor: 'var(--ac-surface-muted)',
                    color: 'var(--ac-text-subtle)',
                  }}
                >
                  +{editFiles.length - 5} more files
                </div>
              ) : null}
            </>
          ) : null}

          {item.tool.kind === 'run' && item.tool.details ? (
            <>
              <div
                className="px-3 py-2 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto ac-scroll"
                style={{
                  backgroundColor: 'var(--ac-code-bg)',
                  color: 'var(--ac-code-text)',
                }}
              >
                {truncatedDetails}
              </div>
              {isDetailsTruncated ? (
                <button
                  className="w-full px-3 py-1 text-[10px] text-left cursor-pointer"
                  style={{
                    backgroundColor: 'var(--ac-surface-muted)',
                    color: 'var(--ac-link)',
                  }}
                  onClick={() => setExpanded((current) => !current)}
                >
                  {expanded ? 'Show less' : 'Show more...'}
                </button>
              ) : null}
            </>
          ) : null}

          {item.tool.kind !== 'run' && item.tool.details ? (
            <>
              <div
                className="px-3 py-2 whitespace-pre-wrap break-words max-h-[150px] overflow-y-auto ac-scroll"
                style={{
                  backgroundColor: 'var(--ac-code-bg)',
                  color: 'var(--ac-code-text)',
                }}
              >
                {truncatedDetails}
              </div>
              {isDetailsTruncated ? (
                <button
                  className="w-full px-3 py-1 text-[10px] text-left cursor-pointer"
                  style={{
                    backgroundColor: 'var(--ac-surface-muted)',
                    color: 'var(--ac-link)',
                  }}
                  onClick={() => setExpanded((current) => !current)}
                >
                  {expanded ? 'Show less' : 'Show more...'}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {item.isError ? (
        <div className="text-[11px]" style={{ color: 'var(--ac-danger)' }}>
          Error occurred
        </div>
      ) : null}
    </div>
  );
}
