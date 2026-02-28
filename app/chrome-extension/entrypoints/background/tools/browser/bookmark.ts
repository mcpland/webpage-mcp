import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { getMessage } from '@/utils/i18n';

/**
 * Bookmark search tool parameters interface
 */
interface BookmarkSearchToolParams {
  query?: string; // Search keywords for matching bookmark titles and URLs
  maxResults?: number; // Maximum number of results to return
  folderPath?: string; // Optional, specify which folder to search in (can be ID or path string like "Work/Projects")
}

/**
 * Bookmark add tool parameters interface
 */
interface BookmarkAddToolParams {
  url?: string; // URL to add as bookmark, if not provided use current active tab URL
  title?: string; // Bookmark title, if not provided use page title
  parentId?: string; // Parent folder ID or path string (like "Work/Projects"), if not provided add to "Bookmarks Bar" folder
  createFolder?: boolean; // Whether to automatically create parent folder if it doesn't exist
  tabId?: number; // target tab when url is omitted
  windowId?: number; // preferred window when tabId/url are omitted
}

/**
 * Bookmark delete tool parameters interface
 */
interface BookmarkDeleteToolParams {
  bookmarkId?: string; // ID of bookmark to delete
  url?: string; // URL of bookmark to delete (if ID not provided, search by URL)
  title?: string; // Title of bookmark to delete (used for auxiliary matching, used together with URL)
}

// --- Helper Functions ---

/**
 * Get the complete folder path of a bookmark
 * @param bookmarkNodeId ID of the bookmark or folder
 * @returns Returns folder path string (e.g., "Bookmarks Bar > Folder A > Subfolder B")
 */
async function getBookmarkFolderPath(bookmarkNodeId: string): Promise<string> {
  const pathParts: string[] = [];

  try {
    // First get the node itself to check if it's a bookmark or folder
    const initialNodes = await chrome.bookmarks.get(bookmarkNodeId);
    if (initialNodes.length > 0 && initialNodes[0]) {
      const initialNode = initialNodes[0];

      // Build path starting from parent node (same for both bookmarks and folders)
      let pathNodeId = initialNode.parentId;
      while (pathNodeId) {
        const parentNodes = await chrome.bookmarks.get(pathNodeId);
        if (parentNodes.length === 0) break;

        const parentNode = parentNodes[0];
        if (parentNode.title) {
          pathParts.unshift(parentNode.title);
        }

        if (!parentNode.parentId) break;
        pathNodeId = parentNode.parentId;
      }
    }
  } catch (error) {
    console.error(`Error getting bookmark path for node ID ${bookmarkNodeId}:`, error);
    return pathParts.join(' > ') || 'Error getting path';
  }

  return pathParts.join(' > ');
}

/**
 * Find bookmark folder by ID or path string
 * If it's an ID, validate it
 * If it's a path string, try to parse it
 * @param pathOrId Path string (e.g., "Work/Projects") or folder ID
 * @returns Returns folder node, or null if not found
 */
async function findFolderByPathOrId(
  pathOrId: string,
): Promise<chrome.bookmarks.BookmarkTreeNode | null> {
  try {
    const nodes = await chrome.bookmarks.get(pathOrId);
    if (nodes && nodes.length > 0 && !nodes[0].url) {
      return nodes[0];
    }
  } catch (e) {
    // do nothing, try to parse as path string
  }

  const pathParts = pathOrId
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (pathParts.length === 0) return null;

  const rootChildren = await chrome.bookmarks.getChildren('0');

  let currentNodes = rootChildren;
  let foundFolder: chrome.bookmarks.BookmarkTreeNode | null = null;

  for (let i = 0; i < pathParts.length; i++) {
    const part = pathParts[i];
    foundFolder = null;
    let matchedNodeThisLevel: chrome.bookmarks.BookmarkTreeNode | null = null;

    for (const node of currentNodes) {
      if (!node.url && node.title.toLowerCase() === part.toLowerCase()) {
        matchedNodeThisLevel = node;
        break;
      }
    }

    if (matchedNodeThisLevel) {
      if (i === pathParts.length - 1) {
        foundFolder = matchedNodeThisLevel;
      } else {
        currentNodes = await chrome.bookmarks.getChildren(matchedNodeThisLevel.id);
      }
    } else {
      return null;
    }
  }

  return foundFolder;
}

/**
 * Create folder path (if it doesn't exist)
 * @param folderPath Folder path string (e.g., "Work/Projects/Subproject")
 * @param parentId Optional parent folder ID, defaults to "Bookmarks Bar"
 * @returns Returns the created or found final folder node
 */
async function createFolderPath(
  folderPath: string,
  parentId?: string,
): Promise<chrome.bookmarks.BookmarkTreeNode> {
  const pathParts = folderPath
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (pathParts.length === 0) {
    throw new Error('Folder path cannot be empty');
  }

  // If no parent ID specified, use "Bookmarks Bar" folder
  let currentParentId: string = parentId || '';
  if (!currentParentId) {
    const rootChildren = await chrome.bookmarks.getChildren('0');
    // Find "Bookmarks Bar" folder (usually ID is '1', but search by title for compatibility)
    const bookmarkBarFolder = rootChildren.find(
      (node) =>
        !node.url &&
        (node.title === getMessage('bookmarksBarLabel') ||
          node.title === 'Bookmarks bar' ||
          node.title === 'Bookmarks Bar'),
    );
    currentParentId = bookmarkBarFolder?.id || '1'; // fallback to default ID
  }

  let currentFolder: chrome.bookmarks.BookmarkTreeNode | null = null;

  // Create or find folders level by level
  for (const folderName of pathParts) {
    const children: chrome.bookmarks.BookmarkTreeNode[] =
      await chrome.bookmarks.getChildren(currentParentId);

    // Check if folder with same name already exists
    const existingFolder: chrome.bookmarks.BookmarkTreeNode | undefined = children.find(
      (child: chrome.bookmarks.BookmarkTreeNode) =>
        !child.url && child.title.toLowerCase() === folderName.toLowerCase(),
    );

    if (existingFolder) {
      currentFolder = existingFolder;
      currentParentId = existingFolder.id;
    } else {
      // Create new folder
      currentFolder = await chrome.bookmarks.create({
        parentId: currentParentId,
        title: folderName,
      });
      currentParentId = currentFolder.id;
    }
  }

  if (!currentFolder) {
    throw new Error('Failed to create folder path');
  }

  return currentFolder;
}

/**
 * Flatten bookmark tree (or node array) to bookmark list (excluding folders)
 * @param nodes Bookmark tree nodes to flatten
 * @returns Returns actual bookmark node array (nodes with URLs)
 */
function flattenBookmarkNodesToBookmarks(
  nodes: chrome.bookmarks.BookmarkTreeNode[],
): chrome.bookmarks.BookmarkTreeNode[] {
  const result: chrome.bookmarks.BookmarkTreeNode[] = [];
  const stack = [...nodes]; // Use stack for iterative traversal to avoid deep recursion issues

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    if (node.url) {
      // It's a bookmark
      result.push(node);
    }

    if (node.children) {
      // Add child nodes to stack for processing
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]);
      }
    }
  }

  return result;
}

/**
 * Find bookmarks by URL and title
 * @param url Bookmark URL
 * @param title Optional bookmark title for auxiliary matching
 * @returns Returns array of matching bookmarks
 */
async function findBookmarksByUrl(
  url: string,
  title?: string,
): Promise<chrome.bookmarks.BookmarkTreeNode[]> {
  // Use Chrome API to search by URL
  const searchResults = await chrome.bookmarks.search({ url });

  if (!title) {
    return searchResults;
  }

  // If title is provided, further filter results
  const titleLower = title.toLowerCase();
  return searchResults.filter(
    (bookmark) => bookmark.title && bookmark.title.toLowerCase().includes(titleLower),
  );
}

/**
 * Bookmark search tool
 * Used to search bookmarks in Chrome browser
 */
class BookmarkSearchTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.BOOKMARK_SEARCH;

  /**
   * Execute bookmark search
   */
  async execute(args: BookmarkSearchToolParams): Promise<ToolResult> {
    const { query = '', maxResults = 50, folderPath } = args;

    console.log(
      `BookmarkSearchTool: Searching bookmarks, keywords: "${query}", folder path: "${folderPath}"`,
    );

    try {
      let bookmarksToSearch: chrome.bookmarks.BookmarkTreeNode[] = [];
      let targetFolderNode: chrome.bookmarks.BookmarkTreeNode | null = null;

      // If folder path is specified, find that folder first
      if (folderPath) {
        targetFolderNode = await findFolderByPathOrId(folderPath);
        if (!targetFolderNode) {
          return createErrorResponse(`Specified folder not found: "${folderPath}"`);
        }
        // Get all bookmarks in that folder and its subfolders
        const subTree = await chrome.bookmarks.getSubTree(targetFolderNode.id);
        bookmarksToSearch =
          subTree.length > 0 ? flattenBookmarkNodesToBookmarks(subTree[0].children || []) : [];
      }

      let filteredBookmarks: chrome.bookmarks.BookmarkTreeNode[];

      if (query) {
        if (targetFolderNode) {
          // Has query keywords and specified folder: manually filter bookmarks from folder
          const lowerCaseQuery = query.toLowerCase();
          filteredBookmarks = bookmarksToSearch.filter(
            (bookmark) =>
              (bookmark.title && bookmark.title.toLowerCase().includes(lowerCaseQuery)) ||
              (bookmark.url && bookmark.url.toLowerCase().includes(lowerCaseQuery)),
          );
        } else {
          // Has query keywords but no specified folder: use API search
          filteredBookmarks = await chrome.bookmarks.search({ query });
          // API search may return folders (if title matches), filter them out
          filteredBookmarks = filteredBookmarks.filter((item) => !!item.url);
        }
      } else {
        // No query keywords
        if (!targetFolderNode) {
          // No folder path specified, get all bookmarks
          const tree = await chrome.bookmarks.getTree();
          bookmarksToSearch = flattenBookmarkNodesToBookmarks(tree);
        }
        filteredBookmarks = bookmarksToSearch;
      }

      // Limit number of results
      const limitedResults = filteredBookmarks.slice(0, maxResults);

      // Add folder path information for each bookmark
      const resultsWithPath = await Promise.all(
        limitedResults.map(async (bookmark) => {
          const path = await getBookmarkFolderPath(bookmark.id);
          return {
            id: bookmark.id,
            title: bookmark.title,
            url: bookmark.url,
            dateAdded: bookmark.dateAdded,
            folderPath: path,
          };
        }),
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                totalResults: resultsWithPath.length,
                query: query || null,
                folderSearched: targetFolderNode
                  ? targetFolderNode.title || targetFolderNode.id
                  : 'All bookmarks',
                bookmarks: resultsWithPath,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error searching bookmarks:', error);
      return createErrorResponse(
        `Error searching bookmarks: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Bookmark add tool
 * Used to add new bookmarks to Chrome browser
 */
class BookmarkAddTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.BOOKMARK_ADD;

  /**
   * Execute add bookmark operation
   */
  async execute(args: BookmarkAddToolParams): Promise<ToolResult> {
    const { url, title, parentId, createFolder = false, tabId, windowId } = args;

    console.log(`BookmarkAddTool: Adding bookmark, options:`, args);

    try {
      // If no URL provided, use current active tab
      let bookmarkUrl = url;
      let bookmarkTitle = title;

      if (!bookmarkUrl) {
        // Get target tab
        const explicit = await this.tryGetTab(tabId);
        const tab = explicit || (await this.getActiveTabInWindow(windowId));
        if (!tab || !tab.url) {
          // tab.url might be undefined (e.g., chrome:// pages)
          return createErrorResponse('No active tab with valid URL found, and no URL provided');
        }

        bookmarkUrl = tab.url;
        if (!bookmarkTitle) {
          bookmarkTitle = tab.title || bookmarkUrl; // If tab title is empty, use URL as title
        }
      }

      if (!bookmarkUrl) {
        // Should have been caught above, but as a safety measure
        return createErrorResponse('URL is required to create bookmark');
      }

      // Parse parentId (could be ID or path string)
      let actualParentId: string | undefined = undefined;
      if (parentId) {
        let folderNode = await findFolderByPathOrId(parentId);

        if (!folderNode && createFolder) {
          // If folder doesn't exist and creation is allowed, create folder path
          try {
            folderNode = await createFolderPath(parentId);
          } catch (createError) {
            return createErrorResponse(
              `Failed to create folder path: ${createError instanceof Error ? createError.message : String(createError)}`,
            );
          }
        }

        if (folderNode) {
          actualParentId = folderNode.id;
        } else {
          // Check if parentId might be a direct ID missed by findFolderByPathOrId (e.g., root folder '1')
          try {
            const nodes = await chrome.bookmarks.get(parentId);
            if (nodes && nodes.length > 0 && !nodes[0].url) {
              actualParentId = nodes[0].id;
            } else {
              return createErrorResponse(
                `Specified parent folder (ID/path: "${parentId}") not found or is not a folder${createFolder ? ', and creation failed' : '. You can set createFolder=true to auto-create folders'}`,
              );
            }
          } catch (e) {
            return createErrorResponse(
              `Specified parent folder (ID/path: "${parentId}") not found or invalid${createFolder ? ', and creation failed' : '. You can set createFolder=true to auto-create folders'}`,
            );
          }
        }
      } else {
        // If no parentId specified, default to "Bookmarks Bar"
        const rootChildren = await chrome.bookmarks.getChildren('0');
        const bookmarkBarFolder = rootChildren.find(
          (node) =>
            !node.url &&
            (node.title === getMessage('bookmarksBarLabel') ||
              node.title === 'Bookmarks bar' ||
              node.title === 'Bookmarks Bar'),
        );
        actualParentId = bookmarkBarFolder?.id || '1'; // fallback to default ID
      }
      // If actualParentId is still undefined, chrome.bookmarks.create will use default "Other Bookmarks", but we've set Bookmarks Bar

      // Create bookmark
      const newBookmark = await chrome.bookmarks.create({
        parentId: actualParentId, // If undefined, API uses default value
        title: bookmarkTitle || bookmarkUrl, // Ensure title is never empty
        url: bookmarkUrl,
      });

      // Get bookmark path
      const path = await getBookmarkFolderPath(newBookmark.id);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: 'Bookmark added successfully',
                bookmark: {
                  id: newBookmark.id,
                  title: newBookmark.title,
                  url: newBookmark.url,
                  dateAdded: newBookmark.dateAdded,
                  folderPath: path,
                },
                folderCreated: createFolder && parentId ? 'Folder created if necessary' : false,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error adding bookmark:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Provide more specific error messages for common error cases, such as trying to bookmark chrome:// URLs
      if (errorMessage.includes("Can't bookmark URLs of type")) {
        return createErrorResponse(
          `Error adding bookmark: Cannot bookmark this type of URL (e.g., chrome:// system pages). ${errorMessage}`,
        );
      }

      return createErrorResponse(`Error adding bookmark: ${errorMessage}`);
    }
  }
}

/**
 * Bookmark delete tool
 * Used to delete bookmarks in Chrome browser
 */
class BookmarkDeleteTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.BOOKMARK_DELETE;

  /**
   * Execute delete bookmark operation
   */
  async execute(args: BookmarkDeleteToolParams): Promise<ToolResult> {
    const { bookmarkId, url, title } = args;

    console.log(`BookmarkDeleteTool: Deleting bookmark, options:`, args);

    if (!bookmarkId && !url) {
      return createErrorResponse('Must provide bookmark ID or URL to delete bookmark');
    }

    try {
      let bookmarksToDelete: chrome.bookmarks.BookmarkTreeNode[] = [];

      if (bookmarkId) {
        // Delete by ID
        try {
          const nodes = await chrome.bookmarks.get(bookmarkId);
          if (nodes && nodes.length > 0 && nodes[0].url) {
            bookmarksToDelete = nodes;
          } else {
            return createErrorResponse(
              `Bookmark with ID "${bookmarkId}" not found, or the ID does not correspond to a bookmark`,
            );
          }
        } catch (error) {
          return createErrorResponse(`Invalid bookmark ID: "${bookmarkId}"`);
        }
      } else if (url) {
        // Delete by URL
        bookmarksToDelete = await findBookmarksByUrl(url, title);
        if (bookmarksToDelete.length === 0) {
          return createErrorResponse(
            `No bookmark found with URL "${url}"${title ? ` (title contains: "${title}")` : ''}`,
          );
        }
      }

      // Delete found bookmarks
      const deletedBookmarks = [];
      const errors = [];

      for (const bookmark of bookmarksToDelete) {
        try {
          // Get path information before deletion
          const path = await getBookmarkFolderPath(bookmark.id);

          await chrome.bookmarks.remove(bookmark.id);

          deletedBookmarks.push({
            id: bookmark.id,
            title: bookmark.title,
            url: bookmark.url,
            folderPath: path,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push(
            `Failed to delete bookmark "${bookmark.title}" (ID: ${bookmark.id}): ${errorMsg}`,
          );
        }
      }

      if (deletedBookmarks.length === 0) {
        return createErrorResponse(`Failed to delete bookmarks: ${errors.join('; ')}`);
      }

      const result: any = {
        success: true,
        message: `Successfully deleted ${deletedBookmarks.length} bookmark(s)`,
        deletedBookmarks,
      };

      if (errors.length > 0) {
        result.partialSuccess = true;
        result.errors = errors;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error deleting bookmark:', error);
      return createErrorResponse(
        `Error deleting bookmark: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const bookmarkSearchTool = new BookmarkSearchTool();
export const bookmarkAddTool = new BookmarkAddTool();
export const bookmarkDeleteTool = new BookmarkDeleteTool();
