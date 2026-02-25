import { NativeMessageType } from 'webpage-mcp-shared';
import './style.css';
// 引入AgentChat主题样式
import '../sidepanel/styles/agent-chat.css';
import { preloadAgentTheme } from '../sidepanel/composables/useAgentTheme';
import App from './App.vue';
import { mountVueInReact } from '../shared/react/mount-vue-in-react';

void mountVueInReact(App, {
  // 在挂载前预加载主题，防止主题闪烁
  beforeMount: async () => {
    await preloadAgentTheme();

    // Trigger ensure native connection (fire-and-forget, don't block UI mounting)
    void chrome.runtime.sendMessage({ type: NativeMessageType.ENSURE_NATIVE }).catch(() => {
      // Silent failure - background will handle reconnection
    });
  },
});
