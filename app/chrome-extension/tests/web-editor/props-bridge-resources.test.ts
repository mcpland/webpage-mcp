import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElementLocator } from '@/common/web-editor-types';
import {
  createPropsBridge,
  PROPS_BRIDGE_RESOURCE_LIMITS,
} from '@/entrypoints/web-editor/core/props-bridge';

const REQUEST_EVENT = 'web-editor-props:request';
const RESPONSE_EVENT = 'web-editor-props:response';

const locator: ElementLocator = {
  selectors: ['#target'],
  fingerprint: 'div|id=target',
  path: [],
};

describe('props bridge resource limits', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('caps pending requests before allocating another timer', async () => {
    const bridge = createPropsBridge();
    const pending = Array.from({ length: PROPS_BRIDGE_RESOURCE_LIMITS.maxPendingRequests }, () =>
      bridge.probe(),
    );

    await expect(bridge.probe()).resolves.toEqual({
      ok: false,
      error: 'Too many pending props requests',
    });

    bridge.dispose();
    await expect(Promise.all(pending)).resolves.toHaveLength(
      PROPS_BRIDGE_RESOURCE_LIMITS.maxPendingRequests,
    );
  });

  it('caps non-finite caller timeouts', async () => {
    const timeoutSpy = vi.spyOn(window, 'setTimeout');
    const bridge = createPropsBridge({ defaultTimeoutMs: Infinity });
    const result = bridge.probe(undefined, Infinity);

    expect(timeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      PROPS_BRIDGE_RESOURCE_LIMITS.maxTimeoutMs,
    );

    bridge.dispose();
    await expect(result).resolves.toMatchObject({
      ok: false,
      error: 'PropsBridge disposed',
    });
  });

  it('rejects oversized locator, path, value, and request payloads before dispatch', async () => {
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const bridge = createPropsBridge();
    const oversizedLocator: ElementLocator = {
      ...locator,
      selectors: Array.from(
        { length: PROPS_BRIDGE_RESOURCE_LIMITS.maxSelectors + 1 },
        (_, index) => `#target-${index}`,
      ),
    };

    await expect(bridge.read(oversizedLocator)).resolves.toMatchObject({
      ok: false,
      error: 'Invalid element locator',
    });
    await expect(
      bridge.write(locator, ['x'.repeat(PROPS_BRIDGE_RESOURCE_LIMITS.maxPropSegmentBytes + 1)], 1),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      bridge.write(locator, ['value'], 'x'.repeat(PROPS_BRIDGE_RESOURCE_LIMITS.maxValueBytes + 1)),
    ).resolves.toMatchObject({
      ok: false,
      error: 'Prop value exceeds the resource limit',
    });

    const largeRequestLocator: ElementLocator = {
      ...locator,
      selectors: Array.from(
        { length: PROPS_BRIDGE_RESOURCE_LIMITS.maxSelectors },
        (_, index) => `[data-${index}="${'x'.repeat(4_080)}"]`,
      ),
    };
    await expect(bridge.read(largeRequestLocator)).resolves.toMatchObject({
      ok: false,
      error: 'Props request exceeds the resource limit',
    });

    expect(
      dispatch.mock.calls.filter(([event]) => (event as Event).type === REQUEST_EVENT),
    ).toHaveLength(0);
    bridge.dispose();
  });

  it('ignores malformed matching responses until a bounded schema-valid response arrives', async () => {
    const bridge = createPropsBridge();
    let requestId = '';
    const captureRequest = (event: Event) => {
      requestId = (event as CustomEvent).detail.requestId;
    };
    window.addEventListener(REQUEST_EVENT, captureRequest, { once: true });
    const result = bridge.read(locator);
    expect(requestId).not.toBe('');

    let settled = false;
    void result.then(() => {
      settled = true;
    });
    window.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: {
          v: 1,
          requestId,
          success: true,
          data: { props: { kind: 'props', entries: 'not-an-array' } },
        },
      }),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    window.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: {
          v: 1,
          requestId,
          success: true,
          data: {
            hookStatus: 'READY',
            framework: 'react',
            capabilities: {
              canRead: true,
              canWrite: true,
              canWriteHooks: false,
            },
            props: {
              kind: 'props',
              entries: [
                {
                  key: 'label',
                  editable: true,
                  value: { kind: 'string', value: 'Save' },
                },
              ],
            },
          },
        },
      }),
    );

    await expect(result).resolves.toMatchObject({
      ok: true,
      data: { props: { entries: [{ key: 'label' }] } },
    });
    bridge.dispose();
  });

  it('ignores a response that exceeds the total byte ceiling', async () => {
    const bridge = createPropsBridge();
    let requestId = '';
    window.addEventListener(
      REQUEST_EVENT,
      (event) => {
        requestId = (event as CustomEvent).detail.requestId;
      },
      { once: true },
    );
    const result = bridge.read(locator);

    window.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: {
          v: 1,
          requestId,
          success: false,
          error: 'x'.repeat(PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes + 1),
        },
      }),
    );
    await Promise.resolve();

    bridge.dispose();
    await expect(result).resolves.toMatchObject({
      ok: false,
      error: 'PropsBridge disposed',
    });
  });

  it('accepts the agent serializer maximum semantic depth within the bridge depth cap', async () => {
    const bridge = createPropsBridge();
    let requestId = '';
    window.addEventListener(
      REQUEST_EVENT,
      (event) => {
        requestId = (event as CustomEvent).detail.requestId;
      },
      { once: true },
    );
    const result = bridge.read(locator);
    let value: Record<string, unknown> = {
      kind: 'max_depth',
      type: '[object Object]',
      preview: '[object Object]',
    };
    for (let depth = 0; depth < 4; depth++) {
      value = { kind: 'object', entries: [{ key: `depth-${depth}`, value }] };
    }

    window.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: {
          v: 1,
          requestId,
          success: true,
          data: {
            props: {
              kind: 'props',
              entries: [{ key: 'nested', editable: false, value }],
            },
          },
        },
      }),
    );

    await expect(result).resolves.toMatchObject({ ok: true });
    bridge.dispose();
  });
});
