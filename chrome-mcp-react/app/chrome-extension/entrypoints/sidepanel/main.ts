import { createApp } from 'vue';
import { NativeMessageType } from 'webpage-mcp-shared';
import App from './App.vue';

// Tailwind first, then custom tokens
import '../styles/tailwind.css';
// AgentChat theme tokens
import './styles/agent-chat.css';

import { preloadAgentTheme } from './composables';

/**
 * Initialize and mount the Vue app.
 * Preloads theme before mounting to prevent flash.
 */
async function init(): Promise<void> {
  // Preload theme from storage and apply to document
  // This happens before Vue mounts, preventing theme flash
  await preloadAgentTheme();

  // Trigger ensure native connection (fire-and-forget, don't block UI mounting)
  void chrome.runtime.sendMessage({ type: NativeMessageType.ENSURE_NATIVE }).catch(() => {
    // Silent failure - background will handle reconnection
  });

  // Mount Vue app
  createApp(App).mount('#app');
}

init();
