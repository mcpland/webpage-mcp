import NodeRenderer from 'markstream-react';
import 'markstream-react/index.css';

type MarkdownRendererProps = {
  content: string;
  className?: string;
  customId?: string;
  customHtmlTags?: readonly string[];
  maxLiveNodes?: number;
  renderBatchSize?: number;
  renderBatchDelay?: number;
};

export default function MarkdownRenderer({
  content,
  className,
  customId,
  customHtmlTags,
  maxLiveNodes,
  renderBatchSize,
  renderBatchDelay,
}: MarkdownRendererProps) {
  return (
    <div className={className}>
      <NodeRenderer
        content={content}
        customId={customId}
        customHtmlTags={customHtmlTags}
        maxLiveNodes={maxLiveNodes}
        renderBatchSize={renderBatchSize}
        renderBatchDelay={renderBatchDelay}
      />
    </div>
  );
}
