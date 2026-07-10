import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import type { ElementChangeSummary } from '@/common/web-editor-types';
import {
  normalizeApplyBatchPayload,
  normalizeApplyPayload,
} from '@/entrypoints/background/web-editor/resource-boundaries';

const nativeHostMocks = vi.hoisted(() => ({
  requestAgentRpcFetch: vi.fn(),
  subscribeAgentStream: vi.fn(),
  unsubscribeAgentStream: vi.fn(),
}));
const authorizationMocks = vi.hoisted(() => ({
  consumePrivilegedUiAuthorization: vi.fn(),
}));
const sidepanelMocks = vi.hoisted(() => ({ openAgentSetupSidepanel: vi.fn() }));
const propsInjectionMocks = vi.hoisted(() => ({
  initPropsAgentEarlyInjectionNavigationLifecycle: vi.fn(),
  pruneOrphanedPropsAgentEarlyInjections: vi.fn(),
  registerPropsAgentEarlyInjection: vi.fn(),
  releasePropsAgentEarlyInjection: vi.fn(),
}));

vi.mock('@/entrypoints/background/native-host', () => nativeHostMocks);
vi.mock('@/entrypoints/background/privileged-ui-authorization', () => authorizationMocks);
vi.mock('@/entrypoints/background/utils/sidepanel', () => sidepanelMocks);
vi.mock('@/entrypoints/background/web-editor/props-early-injection', () => propsInjectionMocks);

type RequestListener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (value: any) => void,
) => boolean | undefined;

function createElement(index = 0, textSize = 0): ElementChangeSummary {
  const locator = {
    selectors: [`button[data-index="${index}"]`],
    fingerprint: `button.primary-${index}`,
    path: [0, index],
  };
  return {
    elementKey: `button-${index}`,
    label: `button-${index}`,
    fullLabel: `body > button-${index}`,
    locator,
    type: 'text',
    changes: {
      text: { beforePreview: 'Before', afterPreview: 'After' },
    },
    transactionIds: [`tx-${index}`],
    netEffect: {
      elementKey: `button-${index}`,
      locator,
      textChange: {
        before: textSize > 0 ? 'a'.repeat(textSize) : 'Before',
        after: textSize > 0 ? 'b'.repeat(textSize) : 'After',
      },
    },
    updatedAt: index,
  };
}

function createApplyPayload(): Record<string, unknown> {
  return {
    pageUrl: 'https://example.com/editor',
    fingerprint: { tag: 'button', classes: ['primary'] },
    instruction: {
      type: 'update_text',
      description: 'Update the button label',
      text: 'Save',
    },
  };
}

function contentSender(): chrome.runtime.MessageSender {
  return {
    id: chrome.runtime.id,
    tab: {
      id: 7,
      windowId: 3,
      url: 'https://example.com/editor',
    } as chrome.tabs.Tab,
    frameId: 0,
    documentId: 'document-a',
  };
}

describe('Web Editor apply resource boundaries', () => {
  let requestListener: RequestListener | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    requestListener = undefined;
    authorizationMocks.consumePrivilegedUiAuthorization.mockReturnValue(true);
    sidepanelMocks.openAgentSetupSidepanel.mockResolvedValue(undefined);
    propsInjectionMocks.pruneOrphanedPropsAgentEarlyInjections.mockResolvedValue(undefined);
    propsInjectionMocks.releasePropsAgentEarlyInjection.mockResolvedValue(undefined);
    nativeHostMocks.subscribeAgentStream.mockResolvedValue({
      subscriptionId: 'subscription-1',
    });
    nativeHostMocks.unsubscribeAgentStream.mockResolvedValue(undefined);
    nativeHostMocks.requestAgentRpcFetch.mockResolvedValue({
      ok: true,
      statusCode: 200,
      json: { requestId: 'request-1' },
      body: '',
    });
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      'agent-selected-session-id': 'session-1',
    });
    chrome.storage.session = {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof chrome.storage.session;
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation((listener) => {
      if (!requestListener) requestListener = listener as RequestListener;
    });

    const { initWebEditorListeners } = await import('@/entrypoints/background/web-editor');
    initWebEditorListeners();
  });

  async function send(message: unknown): Promise<Record<string, unknown>> {
    const sendResponse = vi.fn();
    expect(requestListener!(message, contentSender(), sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    return sendResponse.mock.calls[0]![0] as Record<string, unknown>;
  }

  it('rejects raw depth and field collections before allocating normalized copies', () => {
    const applyPayload = createApplyPayload();
    let nested: Record<string, unknown> = {};
    applyPayload.extra = nested;
    for (let index = 0; index < 25; index += 1) {
      const next: Record<string, unknown> = {};
      nested.next = next;
      nested = next;
    }
    expect(() => normalizeApplyPayload(applyPayload)).toThrow(/JSON depth limit/);

    const tooManyStyles = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`--property-${index}`, 'value']),
    );
    expect(() =>
      normalizeApplyPayload({
        ...createApplyPayload(),
        instruction: {
          type: 'update_style',
          description: 'Update styles',
          style: tooManyStyles,
        },
      }),
    ).toThrow(/style property limit/);

    expect(() =>
      normalizeApplyPayload({
        ...createApplyPayload(),
        fingerprint: { tag: 'button', classes: Array(129).fill('class-name') },
      }),
    ).toThrow(/fingerprint\.classes.*item limit/);
  });

  it('bounds batch elements, exclusions, locators, debug source, and net effects', () => {
    expect(() =>
      normalizeApplyBatchPayload({
        elements: Array.from({ length: 65 }, (_, index) => createElement(index)),
        excludedKeys: [],
      }),
    ).toThrow(/payload\.elements.*item limit/);

    expect(() =>
      normalizeApplyBatchPayload({
        elements: [
          {
            ...createElement(),
            locator: {
              ...createElement().locator,
              selectors: Array(17).fill('.selector'),
            },
          },
        ],
        excludedKeys: [],
      }),
    ).toThrow(/locator\.selectors.*item limit/);

    expect(() =>
      normalizeApplyBatchPayload({
        elements: [
          {
            ...createElement(),
            debugSource: { file: 'x'.repeat(8 * 1024 + 1) },
          },
        ],
        excludedKeys: [],
      }),
    ).toThrow(/debugSource\.file.*field byte limit/);

    expect(() =>
      normalizeApplyBatchPayload({
        elements: [
          {
            ...createElement(),
            netEffect: {
              ...createElement().netEffect,
              classChanges: { before: Array(129).fill('old'), after: [] },
            },
          },
        ],
        excludedKeys: [],
      }),
    ).toThrow(/classChanges\.before.*item limit/);

    expect(() =>
      normalizeApplyBatchPayload({
        elements: [createElement()],
        excludedKeys: Array(129).fill('element-key'),
      }),
    ).toThrow(/excludedKeys.*item limit/);
  });

  it('enforces the final prompt byte cap before calling the Agent RPC', async () => {
    const response = await send({
      type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY_BATCH,
      authorizationToken: 'apply-token',
      payload: {
        elements: Array.from({ length: 64 }, (_, index) => createElement(index, 2_200)),
        excludedKeys: [],
        pageUrl: 'https://example.com/editor',
      },
    });

    expect(response).toMatchObject({ success: false });
    expect(response.error).toMatch(/agent prompt exceeds the byte limit/);
    expect(nativeHostMocks.requestAgentRpcFetch).not.toHaveBeenCalled();
  });

  it('preserves a normal apply payload and sends only the bounded prompt', async () => {
    const response = await send({
      type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY,
      authorizationToken: 'apply-token',
      payload: createApplyPayload(),
    });

    expect(response).toMatchObject({
      success: true,
      requestId: 'request-1',
      sessionId: 'session-1',
    });
    const request = nativeHostMocks.requestAgentRpcFetch.mock.calls[0]![0];
    expect(request.operation).toBe('agent.chat.act');
    expect(JSON.parse(request.body)).toMatchObject({
      dbSessionId: 'session-1',
      instruction: expect.stringContaining('Update the button label'),
    });
  });
});
