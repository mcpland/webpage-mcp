/**
 * Quick Panel Markdown Renderer
 *
 * Simple markdown renderer for Quick Panel.
 * Currently uses plain text rendering - markdown support to be added later
 * when proper Vue/content-script integration is resolved.
 */

// ============================================================
// Types
// ============================================================

export interface MarkdownRendererInstance {
  /** Update the markdown content */
  setContent: (content: string, isStreaming?: boolean) => void;
  /** Get current content */
  getContent: () => string;
  /** Dispose resources */
  dispose: () => void;
}

// ============================================================
// Main Factory
// ============================================================

/**
 * Create a markdown renderer instance that mounts to a container element.
 * Currently renders as plain text - markdown support pending.
 *
 * @param container - The DOM element to render content into
 * @returns Markdown renderer instance with setContent and dispose methods
 */
export function createMarkdownRenderer(container: HTMLElement): MarkdownRendererInstance {
  let currentContent = '';

  // Create a wrapper div for content
  const contentEl = document.createElement('div');
  contentEl.className = 'qp-markdown-content';
  container.appendChild(contentEl);

  return {
    setContent(newContent: string, _streaming = false) {
      currentContent = newContent;
      // For now, render as plain text with basic whitespace preservation
      contentEl.textContent = newContent;
    },

    getContent() {
      return currentContent;
    },

    dispose() {
      try {
        contentEl.remove();
      } catch {
        // Best-effort cleanup
      }
    },
  };
}
