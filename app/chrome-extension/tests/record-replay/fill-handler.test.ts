import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
  uploadLocalFileToInputInternal: vi.fn(),
  locate: vi.fn(),
  tabsSendMessage: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: mocks.handleCallTool,
}));

vi.mock('@/entrypoints/background/tools/browser/file-upload', () => ({
  uploadLocalFileToInputInternal: mocks.uploadLocalFileToInputInternal,
}));

vi.mock('@/shared/selector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/selector')>();
  return {
    ...actual,
    createChromeSelectorLocator: () => ({
      locate: mocks.locate,
    }),
  };
});

import { fillHandler } from '@/entrypoints/background/record-replay/actions/handlers/fill';

describe('fillHandler local file restrictions', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());

    mocks.handleCallTool.mockResolvedValue({});
    mocks.locate.mockResolvedValue({
      ref: 'ref_upload',
      frameId: 0,
      resolvedBy: 'css',
    });
    mocks.tabsSendMessage.mockImplementation(async (_tabId: number, message: unknown) => {
      const msg = message as { action?: string };
      switch (msg.action) {
        case 'resolveRef':
          return { rect: { width: 100, height: 24 } };
        case 'getAttributeForSelector':
          return { value: 'file' };
        default:
          return { success: true };
      }
    });

    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage: mocks.tabsSendMessage,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects file inputs when the run disallows local file uploads', async () => {
    const result = await fillHandler.run(
      {
        vars: {},
        tabId: 11,
        frameId: 0,
        execution: { disallowLocalFileUploads: true },
        log: vi.fn(),
      } as any,
      {
        id: 'fill-upload',
        type: 'fill',
        params: {
          target: {
            candidates: [{ type: 'css', selector: '#upload' }],
          },
          value: '/tmp/demo.txt',
        },
      } as any,
    );

    expect(result).toEqual({
      status: 'failed',
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Public flow runs cannot upload local files to file inputs',
      },
    });
    expect(mocks.uploadLocalFileToInputInternal).not.toHaveBeenCalled();
  });
});
