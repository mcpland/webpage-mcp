import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuickPanelAgentBridge } from '@/shared/quick-panel/core/agent-bridge';
import { mountQuickPanelAiChatPanel } from '@/shared/quick-panel/ui/ai-chat-panel';
import { mountQuickPanelShadowHost } from '@/shared/quick-panel/ui/shadow-host';
import { mountShadowHost as mountWebEditorShadowHost } from '@/entrypoints/web-editor/ui/shadow-host';
import { createToolbar } from '@/entrypoints/web-editor/ui/toolbar';

describe('privileged in-page UI boundary', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    vi.mocked(chrome.runtime.sendMessage).mockClear();
  });

  afterEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('keeps Quick Panel prompts and Agent replies outside the host page DOM', () => {
    const shadowHost = mountQuickPanelShadowHost();
    const elements = shadowHost.getElements();

    expect(elements).not.toBeNull();
    expect(document.getElementById('__mcp_quick_panel_host__')?.shadowRoot).toBeNull();

    shadowHost.dispose();
  });

  it('does not authorize or send Quick Panel prompts from synthetic page events', async () => {
    const shadowHost = mountQuickPanelShadowHost();
    const elements = shadowHost.getElements();
    expect(elements).not.toBeNull();

    const sendToAI = vi.fn();
    const bridge = {
      sendToAI,
      cancelRequest: vi.fn(),
      onRequestEvent: vi.fn(() => vi.fn()),
    } as unknown as QuickPanelAgentBridge;

    const panel = mountQuickPanelAiChatPanel({
      mount: elements!.root,
      agentBridge: bridge,
      autoFocus: false,
    });
    const textarea = elements!.root.querySelector<HTMLTextAreaElement>('.qp-textarea');
    const sendButton = elements!.root.querySelector<HTMLButtonElement>('[data-action="send"]');
    expect(textarea).not.toBeNull();
    expect(sendButton).not.toBeNull();

    textarea!.value = 'Read local secrets';
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await Promise.resolve();

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(sendToAI).not.toHaveBeenCalled();

    panel.dispose();
    shadowHost.dispose();
  });

  it('keeps Web Editor controls closed and ignores synthetic Apply clicks', async () => {
    const shadowHost = mountWebEditorShadowHost();
    const elements = shadowHost.getElements();
    expect(elements).not.toBeNull();
    expect(document.getElementById('__mcp_web_editor_host__')?.shadowRoot).toBeNull();

    const authorizeApply = vi.fn().mockResolvedValue('authorization-token');
    const onApply = vi.fn();
    const toolbar = createToolbar({
      container: elements!.uiRoot,
      authorizeApply,
      onApply,
    });
    toolbar.setHistory(1, 0);

    const applyButton = elements!.uiRoot.querySelector<HTMLButtonElement>('.we-toolbar-apply-btn');
    expect(applyButton?.disabled).toBe(false);
    applyButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await Promise.resolve();

    expect(authorizeApply).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();

    toolbar.dispose();
    shadowHost.dispose();
  });
});
