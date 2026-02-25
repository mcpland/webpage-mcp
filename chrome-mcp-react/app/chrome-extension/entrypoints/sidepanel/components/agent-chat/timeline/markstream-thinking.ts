/**
 * Markstream-vue custom component registration for <thinking> tag.
 *
 * This module registers a custom renderer for <thinking> tags in markdown content.
 * When markstream-vue encounters <thinking>...</thinking>, it will use ThinkingNode.vue
 * to render a collapsible thinking section instead of raw HTML.
 *
 * Usage:
 * 1. Import this module once (side-effect import) to register the component
 * 2. Add `custom-id="agentchat"` and `:custom-html-tags="['thinking']"` to MarkdownRender
 */
import { setCustomComponents } from 'markstream-vue';
import ThinkingNode from './ThinkingNode.vue';

/** Scope ID for AgentChat markdown rendering */
export const AGENTCHAT_MD_SCOPE = 'agentchat';

// Register the thinking node component
setCustomComponents(AGENTCHAT_MD_SCOPE, {
  thinking: ThinkingNode,
});
