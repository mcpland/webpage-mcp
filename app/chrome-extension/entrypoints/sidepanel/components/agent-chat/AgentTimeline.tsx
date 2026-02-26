import type { AgentThreadState, TimelineItem } from '../../composables/useAgentThreads';
import AgentTimelineItem from './AgentTimelineItem';

type AgentTimelineProps = {
  items: TimelineItem[];
  state: AgentThreadState;
  serverPort?: number | null;
};

export default function AgentTimeline({ items, state: _state, serverPort }: AgentTimelineProps) {
  return (
    <div className="pl-1 space-y-3">
      <div className="relative pl-5 space-y-4 ml-1">
        {items.map((item, index) => (
          <AgentTimelineItem
            key={item.id}
            item={item}
            isLast={index === items.length - 1}
            serverPort={serverPort}
          />
        ))}
      </div>
    </div>
  );
}
