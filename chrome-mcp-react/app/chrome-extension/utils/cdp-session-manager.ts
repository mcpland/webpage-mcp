import { TOOL_NAMES } from 'webpage-mcp-shared';

type OwnerTag = string;

interface TabSessionState {
  refCount: number;
  owners: Set<OwnerTag>;
  attachedByUs: boolean;
}

const DEBUGGER_PROTOCOL_VERSION = '1.3';

class CDPSessionManager {
  private sessions = new Map<number, TabSessionState>();

  private getState(tabId: number): TabSessionState | undefined {
    return this.sessions.get(tabId);
  }

  private setState(tabId: number, state: TabSessionState) {
    this.sessions.set(tabId, state);
  }

  async attach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    const state = this.getState(tabId);
    if (state && state.attachedByUs) {
      state.refCount += 1;
      state.owners.add(owner);
      return;
    }

    // Check existing attachments
    const targets = await chrome.debugger.getTargets();
    const existing = targets.find((t) => t.tabId === tabId && t.attached);
    if (existing) {
      if (existing.extensionId === chrome.runtime.id) {
        // Already attached by us (e.g., previous tool). Adopt and refcount.
        this.setState(tabId, {
          refCount: state ? state.refCount + 1 : 1,
          owners: new Set([...(state?.owners || []), owner]),
          attachedByUs: true,
        });
        return;
      }
      // Another client (DevTools/other extension) is attached
      throw new Error(
        `Debugger is already attached to tab ${tabId} by another client (e.g., DevTools/extension)`,
      );
    }

    // Attach freshly
    await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    this.setState(tabId, { refCount: 1, owners: new Set([owner]), attachedByUs: true });
  }

  async detach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    const state = this.getState(tabId);
    if (!state) return; // Nothing to do

    // Update ownership/refcount
    if (state.owners.has(owner)) state.owners.delete(owner);
    state.refCount = Math.max(0, state.refCount - 1);

    if (state.refCount > 0) {
      // Still in use by other owners
      return;
    }

    // We are the last owner
    try {
      if (state.attachedByUs) {
        await chrome.debugger.detach({ tabId });
      }
    } catch (e) {
      // Best-effort detach; ignore
    } finally {
      this.sessions.delete(tabId);
    }
  }

  /**
   * Convenience wrapper: ensures attach before fn, and balanced detach after.
   */
  async withSession<T>(tabId: number, owner: OwnerTag, fn: () => Promise<T>): Promise<T> {
    await this.attach(tabId, owner);
    try {
      return await fn();
    } finally {
      await this.detach(tabId, owner);
    }
  }

  /**
   * Send a CDP command. Requires that this manager has attached to the tab.
   * If not attached by us, will attempt a one-shot attach around the call.
   */
  async sendCommand<T = any>(tabId: number, method: string, params?: object): Promise<T> {
    const state = this.getState(tabId);
    if (state && state.attachedByUs) {
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    }
    // Fallback: temporary session
    return await this.withSession<T>(tabId, `send:${method}`, async () => {
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    });
  }
}

export const cdpSessionManager = new CDPSessionManager();
