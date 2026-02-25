import AgentChatVue from './AgentChat.vue';
import { VueComponentHost } from '@/entrypoints/shared/react/mount-vue-in-react';

export default function AgentChat() {
  return <VueComponentHost component={AgentChatVue} />;
}
