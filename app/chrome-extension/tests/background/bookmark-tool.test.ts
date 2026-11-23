import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BOOKMARK_SEARCH_MAX_FOLDER_PATH_UTF8_BYTES,
  BOOKMARK_SEARCH_MAX_OUTPUT_UTF8_BYTES,
  BOOKMARK_SEARCH_MAX_QUERY_UTF8_BYTES,
  BOOKMARK_SEARCH_MAX_RESULTS,
  BOOKMARK_SEARCH_MAX_SCAN_NODES,
  bookmarkAddTool,
  bookmarkDeleteTool,
  bookmarkSearchTool,
} from '@/entrypoints/background/tools/browser/bookmark';
import type { ToolResult } from '@/common/tool-handler';
import { measureUtf8Bytes } from '@/entrypoints/background/tools/browser/bounded-tool-output';

function resultText(result: ToolResult): string {
  const [content] = result.content;
  if (content?.type !== 'text') throw new Error('Expected a text tool result');
  return content.text;
}

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
    const get = chrome.bookmarks.get as ReturnType<typeof vi.fn>;
    get.mockImplementation(async (id: string) => {
      if (id === '0') {
        return [{ id: '0', title: 'Root' }];
      }
      return [];
    });
    const getChildren = chrome.bookmarks.getChildren as ReturnType<typeof vi.fn>;
    getChildren.mockImplementation(async (id: string) => {
      if (id === '0') {
        return [{ id: '10', title: 'Bookmarks Bar', parentId: '0' }];
      }
      if (id === '10') {
        return [
          { id: '1', title: 'Example', url: 'https://example.com', parentId: '10' },
          { id: '2', title: 'Secret', url: 'file:///tmp/secret.txt', parentId: '10' },
        ];
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
    expect(search).not.toHaveBeenCalled();
    expect(chrome.bookmarks.getTree).not.toHaveBeenCalled();
    expect(chrome.bookmarks.getSubTree).not.toHaveBeenCalled();
  });

  it('stops hierarchical traversal at the scan budget', async () => {
    const get = chrome.bookmarks.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValue([{ id: '0', title: 'Root' }]);
    const getChildren = chrome.bookmarks.getChildren as ReturnType<typeof vi.fn>;
    getChildren.mockResolvedValue(
      Array.from({ length: BOOKMARK_SEARCH_MAX_SCAN_NODES + 100 }, (_, index) => ({
        id: String(index),
        title: `bookmark-${index}`,
        url: `https://example.com/${index}`,
        parentId: '0',
      })),
    );

    const result = await bookmarkSearchTool.execute({ query: 'not-present' });
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(result.isError).toBe(false);
    expect(payload.totalResults).toBe(0);
    expect(payload.scannedNodes).toBe(BOOKMARK_SEARCH_MAX_SCAN_NODES);
    expect(payload.truncated).toBe(true);
  });

  it('clamps results and bounds browser-controlled bookmark output', async () => {
    const huge = 'x'.repeat(20_000);
    const get = chrome.bookmarks.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValue([{ id: '0', title: 'Root' }]);
    const getChildren = chrome.bookmarks.getChildren as ReturnType<typeof vi.fn>;
    getChildren.mockResolvedValue(
      Array.from({ length: BOOKMARK_SEARCH_MAX_RESULTS + 100 }, (_, index) => ({
        id: `${index}-${huge}`,
        title: huge,
        url: `https://example.com/${index}/${huge}`,
        parentId: '0',
      })),
    );

    const result = await bookmarkSearchTool.execute({ maxResults: Number.MAX_SAFE_INTEGER });
    const text = String((result.content[0] as { text?: string })?.text || '');
    const payload = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(payload.totalResults).toBeLessThanOrEqual(BOOKMARK_SEARCH_MAX_RESULTS);
    expect(payload.truncated).toBe(true);
    expect(measureUtf8Bytes(text)).toBeLessThanOrEqual(
      BOOKMARK_SEARCH_MAX_OUTPUT_UTF8_BYTES,
    );
  });

  it('rejects oversized bookmark search fields before traversing', async () => {
    const queryResult = await bookmarkSearchTool.execute({
      query: 'q'.repeat(BOOKMARK_SEARCH_MAX_QUERY_UTF8_BYTES + 1),
    });
    const folderResult = await bookmarkSearchTool.execute({
      folderPath: 'f'.repeat(BOOKMARK_SEARCH_MAX_FOLDER_PATH_UTF8_BYTES + 1),
    });

    expect(queryResult.isError).toBe(true);
    expect(folderResult.isError).toBe(true);
    expect(chrome.bookmarks.get).not.toHaveBeenCalled();
    expect(chrome.bookmarks.getChildren).not.toHaveBeenCalled();
  });

  it('resolves a unique nested folder and refuses ambiguous reads and writes', async () => {
    const tree: Record<string, Pick<chrome.bookmarks.BookmarkTreeNode, 'id' | 'title' | 'url'>[]> = {
      '0': [{ id: '1', title: '收藏夹栏' }, { id: '2', title: '其他收藏夹' }],
      '1': [{ id: '3', title: 'Work' }],
      '3': [{ id: '4', title: 'Projects' }],
      '4': [{ id: '5', title: 'Projects', url: 'https://example.com' }],
      '2': [],
    };
    (chrome.bookmarks.get as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (chrome.bookmarks.getChildren as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => tree[id] ?? []);
    const result = await bookmarkSearchTool.execute({ folderPath: 'projects' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(resultText(result)).bookmarks).toMatchObject([{ id: '5' }]);

    tree['2'].push({ id: '6', title: 'PROJECTS' });
    const ambiguous = await bookmarkSearchTool.execute({ folderPath: 'Projects' });
    const add = await bookmarkAddTool.execute({
      parentId: 'Projects', url: 'https://example.com', createFolder: true,
    });
    for (const rejected of [ambiguous, add]) {
      expect(rejected.isError).toBe(true);
      expect(resultText(rejected)).toContain('Use the full path or folder ID');
    }
    expect(chrome.bookmarks.create).not.toHaveBeenCalled();
    const qualified = await bookmarkSearchTool.execute({ folderPath: '收藏夹栏/Work/Projects' });
    expect(qualified.isError).toBe(false);
    expect(JSON.parse(resultText(qualified)).bookmarks).toMatchObject([{ id: '5' }]);
  });

  it('rejects a partial name match if the scan cannot establish uniqueness', async () => {
    (chrome.bookmarks.get as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (chrome.bookmarks.getChildren as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: '1', title: 'Work' },
      ...Array.from({ length: BOOKMARK_SEARCH_MAX_SCAN_NODES }, () => ({
        id: '2', title: 'Link', url: 'https://example.com',
      })),
    ]);
    const result = await bookmarkAddTool.execute({
      parentId: 'Work', url: 'https://example.com', createFolder: true,
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('scan limit');
    expect(chrome.bookmarks.create).not.toHaveBeenCalled();
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
