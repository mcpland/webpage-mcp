import type { TimelineItem } from '../../../composables/useAgentThreads';

import { AGENTCHAT_MD_SCOPE } from './markstream-thinking';
import MarkdownRenderer from './MarkdownRenderer';
import './timeline-markdown.css';

const CUSTOM_HTML_TAGS = ['thinking'] as const;

type TimelineNarrativeStepProps = {
  item: Extract<TimelineItem, { kind: 'assistant_text' }>;
};

export default function TimelineNarrativeStep({ item }: TimelineNarrativeStepProps) {
  return (
    <div className="py-1">
      <MarkdownRenderer
        className="timeline-markdown-content text-sm leading-relaxed"
        content={item.text ?? ''}
        customId={AGENTCHAT_MD_SCOPE}
        customHtmlTags={CUSTOM_HTML_TAGS}
        maxLiveNodes={0}
        renderBatchSize={16}
        renderBatchDelay={8}
      />
      {item.isStreaming ? (
        <span
          className="inline-block w-1.5 h-4 ml-0.5 ac-pulse"
          style={{ backgroundColor: 'var(--ac-accent)' }}
        />
      ) : null}
    </div>
  );
}
