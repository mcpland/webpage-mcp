import { NativeMessageType } from 'webpage-mcp-shared';
import App from './App.vue';
import { mountVueInReact } from '../shared/react/mount-vue-in-react';

// Tailwind first, then custom tokens
import '../styles/tailwind.css';
// AgentChat theme tokens
import './styles/agent-chat.css';

import { preloadAgentTheme } from './composables';

void mountVueInReact(App, {
  /**
   * Preload theme before mounting to prevent flash.
   */
  beforeMount: async () => {
    // Preload theme from storage and apply to document
    await preloadAgentTheme();

    // Trigger ensure native connection (fire-and-forget, don't block UI mounting)
    void chrome.runtime.sendMessage({ type: NativeMessageType.ENSURE_NATIVE }).catch(() => {
      // Silent failure - background will handle reconnection
    });
  },
});
