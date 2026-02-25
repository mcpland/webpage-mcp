import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeMessageType } from 'webpage-mcp-shared';
import './style.css';
// 引入AgentChat主题样式
import '../sidepanel/styles/agent-chat.css';
import { preloadAgentTheme } from '../sidepanel/composables/useAgentTheme';
import App from './App';

async function bootstrap() {
  // 在挂载前预加载主题，防止主题闪烁
  await preloadAgentTheme();

  // Trigger ensure native connection (fire-and-forget, don't block UI mounting)
  void chrome.runtime.sendMessage({ type: NativeMessageType.ENSURE_NATIVE }).catch(() => {
    // Silent failure - background will handle reconnection
  });

  const mountNode = document.getElementById('app');
  if (!mountNode) {
    throw new Error('Cannot find #app mount node');
  }

  createRoot(mountNode).render(createElement(App));
}

void bootstrap();
