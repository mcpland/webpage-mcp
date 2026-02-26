import { setCustomComponents } from 'markstream-vue';
import ThinkingNode from './ThinkingNodeHost.vue';

export const AGENTCHAT_MD_SCOPE = 'agentchat';

// Register the thinking node component
setCustomComponents(AGENTCHAT_MD_SCOPE, {
  thinking: ThinkingNode,
});
