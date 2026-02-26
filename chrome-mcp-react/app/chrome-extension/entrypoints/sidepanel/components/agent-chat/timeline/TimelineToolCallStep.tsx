import { useMemo } from 'react';

import type { TimelineItem } from '../../../composables/useAgentThreads';

type TimelineToolCallStepProps = {
  item: Extract<TimelineItem, { kind: 'tool_use' }>;
};

export default function TimelineToolCallStep({ item }: TimelineToolCallStepProps) {
  const labelColor = item.tool.kind === 'edit' ? 'var(--ac-accent)' : 'var(--ac-text-subtle)';

  const hasDiffStats = useMemo(() => {
    const stats = item.tool.diffStats;
    if (!stats) {
      return false;
    }

    return stats.addedLines !== undefined || stats.deletedLines !== undefined;
  }, [item.tool.diffStats]);

  const subtitle = useMemo(() => {
    const tool = item.tool;
    if (tool.kind === 'run' && tool.commandDescription && tool.command) {
      return tool.command.length > 60 ? `${tool.command.slice(0, 57)}...` : tool.command;
    }

    if ((tool.kind === 'edit' || tool.kind === 'read') && tool.filePath) {
      if (tool.filePath !== tool.title && !tool.title.includes('/')) {
        return tool.filePath;
      }
    }

    if (tool.kind === 'grep' && tool.searchPath) {
      return `in ${tool.searchPath}`;
    }

    return undefined;
  }, [item.tool]);

  const subtitleFull = useMemo(() => {
    const tool = item.tool;
    if (tool.kind === 'run' && tool.command) return tool.command;
    if (tool.filePath) return tool.filePath;
    if (tool.searchPath) return tool.searchPath;
    return undefined;
  }, [item.tool]);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span
          className="text-[11px] font-bold uppercase tracking-wider flex-shrink-0"
          style={{ color: labelColor }}
        >
          {item.tool.label}
        </span>

        {item.tool.kind === 'grep' || item.tool.kind === 'read' ? (
          <code
            className="text-xs px-1.5 py-0.5 cursor-pointer ac-chip-hover"
            style={{
              fontFamily: 'var(--ac-font-mono)',
              backgroundColor: 'var(--ac-chip-bg)',
              color: 'var(--ac-chip-text)',
              borderRadius: 'var(--ac-radius-button)',
            }}
            title={item.tool.filePath || item.tool.pattern}
          >
            {item.tool.title}
          </code>
        ) : (
          <span
            className="text-xs"
            style={{
              fontFamily: 'var(--ac-font-mono)',
              color: 'var(--ac-text-muted)',
            }}
            title={item.tool.filePath || item.tool.command}
          >
            {item.tool.title}
          </span>
        )}

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
          </span>
        ) : null}

        {item.isStreaming ? (
          <span className="text-xs italic" style={{ color: 'var(--ac-text-subtle)' }}>
            ...
          </span>
        ) : null}
      </div>

      {subtitle ? (
        <div
          className="text-[10px] pl-10 truncate"
          style={{ color: 'var(--ac-text-subtle)' }}
          title={subtitleFull}
        >
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}
