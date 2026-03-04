import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeMessageType } from 'webpage-mcp-shared';
import App from './App';

// Tailwind first, then custom tokens
import '../styles/tailwind.css';
// Shared connector theme tokens
import './styles/connector-theme.css';

import { preloadAgentTheme } from './composables';

async function bootstrap() {
  // Preload theme from storage and apply to document
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
