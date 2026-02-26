import { setCustomComponents } from 'markstream-react';
import ThinkingNode from './ThinkingNode';

export const AGENTCHAT_MD_SCOPE = 'agentchat';

setCustomComponents(AGENTCHAT_MD_SCOPE, {
  thinking: ThinkingNode,
});
