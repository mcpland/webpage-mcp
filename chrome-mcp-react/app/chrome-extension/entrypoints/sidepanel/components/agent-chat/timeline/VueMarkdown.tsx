import MarkdownRender from 'markstream-vue';
import 'markstream-vue/index.css';

import { VueComponentHost } from '@/entrypoints/shared/react/mount-vue-in-react';

type VueMarkdownProps = {
  content: string;
  className?: string;
  customId?: string;
  customHtmlTags?: readonly string[];
  maxLiveNodes?: number;
  renderBatchSize?: number;
  renderBatchDelay?: number;
};

export default function VueMarkdown({
  content,
  className,
  customId,
  customHtmlTags,
  maxLiveNodes,
  renderBatchSize,
  renderBatchDelay,
}: VueMarkdownProps) {
  return (
    <div className={className}>
      <VueComponentHost
        component={MarkdownRender}
        componentProps={{
          content,
          customId,
          customHtmlTags,
          maxLiveNodes,
          renderBatchSize,
          renderBatchDelay,
        }}
      />
    </div>
  );
}
