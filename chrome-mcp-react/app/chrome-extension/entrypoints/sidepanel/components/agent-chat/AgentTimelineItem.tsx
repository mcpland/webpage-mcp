import type { TimelineItem } from '../../composables/useAgentThreads';
import TimelineNarrativeStep from './timeline/TimelineNarrativeStep';
import TimelineStatusStep from './timeline/TimelineStatusStep';
import TimelineToolCallStep from './timeline/TimelineToolCallStep';
import TimelineToolResultCardStep from './timeline/TimelineToolResultCardStep';
import TimelineUserPromptStep from './timeline/TimelineUserPromptStep';

type AgentTimelineItemProps = {
  item: TimelineItem;
  isLast?: boolean;
  serverPort?: number | null;
};

function isStreaming(item: TimelineItem): boolean {
  if (item.kind === 'assistant_text' || item.kind === 'tool_use') {
    return item.isStreaming;
  }

  if (item.kind === 'status') {
    return item.status === 'running' || item.status === 'starting';
  }

  return false;
}

function showLoadingIcon(item: TimelineItem): boolean {
  return item.kind === 'status' && (item.status === 'running' || item.status === 'starting');
}

function getNodeTopOffset(item: TimelineItem): string {
  if (item.kind === 'user_prompt' || item.kind === 'assistant_text') {
    return '12px';
  }

  if (item.kind === 'tool_use' || item.kind === 'tool_result') {
    return '6px';
  }

  if (item.kind === 'status') {
    return '2px';
  }

  return '7px';
}

function getNodeColor(item: TimelineItem): string {
  if (isStreaming(item)) {
    return 'var(--ac-timeline-node-active)';
  }

  if (item.kind === 'tool_result') {
    return item.isError ? 'var(--ac-danger)' : 'var(--ac-success)';
  }

  if (item.kind === 'tool_use') {
    return 'var(--ac-timeline-node-tool)';
  }

  if (item.kind === 'assistant_text') {
    return 'var(--ac-timeline-node-active)';
  }

  if (item.kind === 'user_prompt') {
    return 'var(--ac-timeline-node-hover)';
  }

  if (item.kind === 'status') {
    return 'var(--ac-timeline-node)';
  }

  return 'var(--ac-timeline-node)';
}

export default function AgentTimelineItem({
  item,
  isLast: _isLast,
  serverPort,
}: AgentTimelineItemProps) {
  const nodeTopOffset = getNodeTopOffset(item);
  const nodeColor = getNodeColor(item);
  const streaming = isStreaming(item);
  const loadingIcon = showLoadingIcon(item);

  return (
    <div className="relative group/step">
      {loadingIcon ? (
        <svg
          className="absolute loading-scribble flex-shrink-0"
          style={{
            left: '-24px',
            top: nodeTopOffset,
            width: '14px',
            height: '14px',
          }}
          viewBox="0 0 100 100"
          fill="none"
        >
          <path
            d="M50 50 C50 48, 52 46, 54 46 C58 46, 60 50, 60 54 C60 60, 54 64, 48 64 C40 64, 36 56, 36 48 C36 38, 44 32, 54 32 C66 32, 74 42, 74 54 C74 68, 62 78, 48 78 C32 78, 22 64, 22 48 C22 30, 36 18, 54 18 C74 18, 88 34, 88 54 C88 76, 72 92, 50 92"
            stroke="var(--ac-accent, #D97757)"
            strokeWidth="8"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <span
          className={`absolute w-2 h-2 rounded-full transition-colors${streaming ? ' ac-pulse' : ''}`}
          style={{
            left: '-20px',
            top: nodeTopOffset,
            backgroundColor: nodeColor,
            boxShadow: streaming ? 'var(--ac-timeline-node-pulse-shadow)' : 'none',
          }}
        />
      )}

      {item.kind === 'user_prompt' ? (
        <TimelineUserPromptStep item={item} serverPort={serverPort} />
      ) : null}
      {item.kind === 'assistant_text' ? <TimelineNarrativeStep item={item} /> : null}
      {item.kind === 'tool_use' ? <TimelineToolCallStep item={item} /> : null}
      {item.kind === 'tool_result' ? <TimelineToolResultCardStep item={item} /> : null}
      {item.kind === 'status' ? <TimelineStatusStep item={item} hideIcon={loadingIcon} /> : null}
    </div>
  );
}
