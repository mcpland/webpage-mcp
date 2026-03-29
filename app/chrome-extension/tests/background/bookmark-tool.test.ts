import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bookmarkAddTool,
  bookmarkDeleteTool,
  bookmarkSearchTool,
} from '@/entrypoints/background/tools/browser/bookmark';

describe('bookmark tools', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      bookmarks: {
        search: vi.fn(),
        get: vi.fn(),
        getTree: vi.fn(),
        getChildren: vi.fn(),
        create: vi.fn(),
        remove: vi.fn(),
        getSubTree: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('filters non-public bookmarks from search results', async () => {
    const search = chrome.bookmarks.search as ReturnType<typeof vi.fn>;
    search.mockResolvedValue([
      { id: '1', title: 'Example', url: 'https://example.com', parentId: '10' },
      { id: '2', title: 'Secret', url: 'file:///tmp/secret.txt' },
    ]);
    const get = chrome.bookmarks.get as ReturnType<typeof vi.fn>;
    get.mockImplementation(async (id: string) => {
      if (id === '1') {
        return [{ id: '1', title: 'Example', url: 'https://example.com', parentId: '10' }];
      }
      if (id === '10') {
        return [{ id: '10', title: 'Bookmarks Bar', parentId: '0' }];
      }
      if (id === '0') {
        return [{ id: '0', title: 'Root' }];
      }
      return [];
    });

    const result = await bookmarkSearchTool.execute({ query: 'example' });
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(payload.totalResults).toBe(1);
    expect(payload.bookmarks).toEqual([
      {
        id: '1',
        title: 'Example',
        url: 'https://example.com',
        folderPath: 'Root > Bookmarks Bar',
      },
    ]);
  });

  it('rejects non-public URLs when adding bookmarks', async () => {
    const create = chrome.bookmarks.create as ReturnType<typeof vi.fn>;

    const result = await bookmarkAddTool.execute({
      url: 'file:///tmp/secret.txt',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// URLs are supported by chrome_bookmark_add',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects non-public bookmarks when deleting by id', async () => {
    const get = chrome.bookmarks.get as ReturnType<typeof vi.fn>;
    const remove = chrome.bookmarks.remove as ReturnType<typeof vi.fn>;
    get.mockResolvedValue([
      { id: '2', title: 'Secret', url: 'file:///tmp/secret.txt', parentId: '1' },
    ]);

    const result = await bookmarkDeleteTool.execute({
      bookmarkId: '2',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// bookmarks are supported by chrome_bookmark_delete',
    );
    expect(remove).not.toHaveBeenCalled();
  });
});
