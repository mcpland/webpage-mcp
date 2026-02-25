import { createApp } from 'vue';
import { NativeMessageType } from 'webpage-mcp-shared';
import './style.css';
// 引入AgentChat主题样式
import '../sidepanel/styles/agent-chat.css';
import { preloadAgentTheme } from '../sidepanel/composables/useAgentTheme';
import App from './App.vue';

// 在Vue挂载前预加载主题，防止主题闪烁
preloadAgentTheme().then(() => {
  // Trigger ensure native connection (fire-and-forget, don't block UI mounting)
  void chrome.runtime.sendMessage({ type: NativeMessageType.ENSURE_NATIVE }).catch(() => {
    // Silent failure - background will handle reconnection
  });
  createApp(App).mount('#app');
});
