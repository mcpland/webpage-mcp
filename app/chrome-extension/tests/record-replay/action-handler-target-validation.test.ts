import { describe, expect, it, vi } from 'vitest';

vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools/browser/file-upload', () => ({
  uploadLocalFileToInputInternal: vi.fn(),
}));

vi.mock('@/shared/selector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/selector')>();
  return {
    ...actual,
    createChromeSelectorLocator: () => ({ locate: vi.fn() }),
  };
});

import { clickHandler, dblclickHandler } from '@/entrypoints/background/record-replay/actions/handlers/click';
import { dragHandler } from '@/entrypoints/background/record-replay/actions/handlers/drag';
import { fillHandler } from '@/entrypoints/background/record-replay/actions/handlers/fill';
import { keyHandler } from '@/entrypoints/background/record-replay/actions/handlers/key';
import { scrollHandler } from '@/entrypoints/background/record-replay/actions/handlers/scroll';
import {
  setAttributeHandler,
  triggerEventHandler,
} from '@/entrypoints/background/record-replay/actions/handlers/dom';

describe('action handler target validation', () => {
  it('accepts selector-only element targets', () => {
    const target = { selector: '#submit' };
    const cases = [
      {
        handler: clickHandler,
        action: { id: 'click-1', type: 'click', params: { target } },
      },
      {
        handler: dblclickHandler,
        action: { id: 'dblclick-1', type: 'dblclick', params: { target } },
      },
      {
        handler: fillHandler,
        action: { id: 'fill-1', type: 'fill', params: { target, value: 'hello' } },
      },
      {
        handler: keyHandler,
        action: { id: 'key-1', type: 'key', params: { target, keys: 'Enter' } },
      },
      {
        handler: scrollHandler,
        action: { id: 'scroll-1', type: 'scroll', params: { mode: 'element', target } },
      },
      {
        handler: dragHandler,
        action: {
          id: 'drag-1',
          type: 'drag',
          params: { start: target, end: { selector: '#drop' } },
        },
      },
      {
        handler: triggerEventHandler,
        action: { id: 'trigger-1', type: 'triggerEvent', params: { target, event: 'change' } },
      },
      {
        handler: setAttributeHandler,
        action: {
          id: 'attr-1',
          type: 'setAttribute',
          params: { target, name: 'data-ready', value: 'true' },
        },
      },
    ];

    for (const { handler, action } of cases) {
      expect(handler.validate?.(action as never)).toEqual({ ok: true });
    }
  });
});
