/**
 * Offscreen Document manager
 * Ensures only one offscreen document is created across the entire extension to avoid conflicts
 */

export const OFFSCREEN_CLOSE_RETRY_ALARM_NAME =
  "webpage-mcp.offscreen.close-retry";
const OFFSCREEN_CLOSE_RETRY_DELAY_MS = 60_000;

export class OffscreenManager {
  private static instance: OffscreenManager | null = null;
  private isCreated = false;
  private isCreating = false;
  private createPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly references = new Map<string, number>();
  private totalReferences = 0;
  private pendingOperations = 0;
  private pendingPersistentUsers = 0;
  // Several long-lived consumers predate explicit references and intentionally
  // keep model/encoder state in the shared document. Once one of them calls
  // ensureOffscreenDocument(), an explicit keepalive release must not close the
  // document out from under it. New bounded consumers should use acquire().
  private hasPersistentSharedUser = false;

  private constructor() {
    chrome.alarms?.onAlarm?.addListener(this.handleCloseRetryAlarm);
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): OffscreenManager {
    if (!OffscreenManager.instance) {
      OffscreenManager.instance = new OffscreenManager();
    }
    return OffscreenManager.instance;
  }

  /**
   * Ensure offscreen document exists
   */
  public async ensureOffscreenDocument(): Promise<void> {
    this.pendingPersistentUsers += 1;
    try {
      await this.ensureOffscreenDocumentInternal();
      this.hasPersistentSharedUser = true;
      await this.clearCloseRetryAlarm();
    } finally {
      this.pendingPersistentUsers = Math.max(
        0,
        this.pendingPersistentUsers - 1,
      );
    }
  }

  private async ensureOffscreenDocumentInternal(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
    }

    if (this.isCreated) {
      return;
    }

    if (this.isCreating && this.createPromise) {
      return this.createPromise;
    }

    this.isCreating = true;
    this.pendingOperations += 1;
    this.createPromise = this._doCreateOffscreenDocument().finally(() => {
      this.isCreating = false;
      this.createPromise = null;
      this.pendingOperations = Math.max(0, this.pendingOperations - 1);
    });

    return this.createPromise;
  }

  /**
   * Acquire ownership of the shared offscreen document.
   *
   * References are counted before creation starts so a concurrent final
   * release cannot close a document that another caller is waiting to use.
   * The returned release function is idempotent and resolves only after any
   * zero-reference close attempt has settled.
   */
  public async acquireOffscreenDocument(
    tag: string,
  ): Promise<() => Promise<void>> {
    const normalizedTag = tag.trim() || "anonymous";
    this.totalReferences += 1;
    this.references.set(
      normalizedTag,
      (this.references.get(normalizedTag) ?? 0) + 1,
    );

    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;

      this.totalReferences = Math.max(0, this.totalReferences - 1);
      const current = this.references.get(normalizedTag) ?? 0;
      if (current <= 1) {
        this.references.delete(normalizedTag);
      } else {
        this.references.set(normalizedTag, current - 1);
      }

      if (this.totalReferences === 0) {
        await this.closeOffscreenDocument();
      }
    };

    try {
      await this.ensureOffscreenDocumentInternal();
      return release;
    } catch (error) {
      await release();
      throw error;
    }
  }

  /** Execute one operation while holding an offscreen-document reference. */
  public async runWithOffscreenDocument<T>(
    tag: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquireOffscreenDocument(tag);
    this.pendingOperations += 1;
    try {
      return await operation();
    } finally {
      this.pendingOperations = Math.max(0, this.pendingOperations - 1);
      await release();
    }
  }

  private async _doCreateOffscreenDocument(): Promise<void> {
    try {
      if (!chrome.offscreen) {
        throw new Error("Offscreen API not available. Chrome 109+ required.");
      }

      if (await this._hasOffscreenDocument()) {
        console.log("OffscreenManager: Offscreen document already exists");
        this.isCreated = true;
        return;
      }

      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification: "Need to run semantic similarity engine with workers",
      });

      this.isCreated = true;
      console.log("OffscreenManager: Offscreen document created successfully");
    } catch (error) {
      console.error(
        "OffscreenManager: Failed to create offscreen document:",
        error,
      );
      this.isCreated = false;
      throw error;
    }
  }

  /**
   * Detect an existing document across the full Chrome 109+ support range.
   * runtime.getContexts was added in Chrome 116, so older service workers
   * must inspect their controlled clients instead.
   */
  private async _hasOffscreenDocument(): Promise<boolean> {
    const runtime = chrome.runtime as typeof chrome.runtime & {
      getContexts?: (filter: {
        contextTypes: string[];
      }) => Promise<Array<{ contextType?: string }>>;
    };

    if (typeof runtime.getContexts === "function") {
      const existingContexts = await runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
      });
      return existingContexts.length > 0;
    }

    const serviceWorkerClients = (
      globalThis as typeof globalThis & {
        clients?: {
          matchAll: () => Promise<ArrayLike<{ url: string }>>;
        };
      }
    ).clients;

    if (typeof serviceWorkerClients?.matchAll !== "function") {
      return false;
    }

    const offscreenUrl = chrome.runtime.getURL("offscreen.html");
    const existingClients = await serviceWorkerClients.matchAll();
    return Array.from(existingClients).some(
      (client) => client.url === offscreenUrl,
    );
  }

  /**
   * Check if offscreen document is created
   */
  public isOffscreenDocumentCreated(): boolean {
    return this.isCreated;
  }

  /** Current number of explicit document owners. */
  public getReferenceCount(): number {
    return this.totalReferences;
  }

  /** Current number of create/use operations that have not settled. */
  public getPendingOperationCount(): number {
    return this.pendingOperations;
  }

  /**
   * Close offscreen document
   */
  public async closeOffscreenDocument(): Promise<void> {
    if (
      this.hasPersistentSharedUser ||
      this.pendingPersistentUsers > 0 ||
      this.totalReferences > 0 ||
      this.pendingOperations > 0
    )
      return;
    if (this.closePromise) return this.closePromise;

    const closePromise = this._closeOffscreenDocumentWithRetry()
      .catch(async (error) => {
        console.error(
          "OffscreenManager: Failed to close offscreen document:",
          error,
        );
        await this.scheduleCloseRetry();
      })
      .finally(() => {
        if (this.closePromise === closePromise) {
          this.closePromise = null;
        }
      });
    this.closePromise = closePromise;
    return closePromise;
  }

  private async _closeOffscreenDocumentWithRetry(): Promise<void> {
    const retryDelaysMs = [0, 50, 200];
    let lastError: unknown;

    for (const delayMs of retryDelaysMs) {
      if (
        this.hasPersistentSharedUser ||
        this.pendingPersistentUsers > 0 ||
        this.totalReferences > 0 ||
        this.pendingOperations > 0
      )
        return;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (
        this.hasPersistentSharedUser ||
        this.pendingPersistentUsers > 0 ||
        this.totalReferences > 0 ||
        this.pendingOperations > 0
      )
        return;

      try {
        await this._doCloseOffscreenDocument();
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to close offscreen document");
  }

  private async _doCloseOffscreenDocument(): Promise<void> {
    try {
      if (!chrome.offscreen) return;

      const exists = this.isCreated || (await this._hasOffscreenDocument());
      if (!exists) {
        this.isCreated = false;
        await this.clearCloseRetryAlarm();
        return;
      }

      // A reference may have been acquired while context discovery awaited.
      if (
        this.hasPersistentSharedUser ||
        this.pendingPersistentUsers > 0 ||
        this.totalReferences > 0 ||
        this.pendingOperations > 0
      )
        return;

      await chrome.offscreen.closeDocument();
      this.isCreated = false;
      await this.clearCloseRetryAlarm();
      console.log("OffscreenManager: Offscreen document closed");
    } catch (error) {
      // Keep the cached state conservative so the next acquire re-checks the
      // actual browser context instead of creating a duplicate document.
      this.isCreated = true;
      throw error;
    }
  }

  private readonly handleCloseRetryAlarm = (
    alarm: chrome.alarms.Alarm,
  ): void => {
    if (alarm.name !== OFFSCREEN_CLOSE_RETRY_ALARM_NAME) return;
    void this.closeOffscreenDocument();
  };

  private async scheduleCloseRetry(): Promise<void> {
    if (
      this.hasPersistentSharedUser ||
      this.pendingPersistentUsers > 0 ||
      this.totalReferences > 0 ||
      this.pendingOperations > 0
    ) {
      return;
    }
    if (!chrome.alarms?.create) {
      console.error(
        "OffscreenManager: chrome.alarms is unavailable; close retry was not scheduled",
      );
      return;
    }
    try {
      await Promise.resolve(
        chrome.alarms.create(OFFSCREEN_CLOSE_RETRY_ALARM_NAME, {
          when: Date.now() + OFFSCREEN_CLOSE_RETRY_DELAY_MS,
        }),
      );
    } catch (error) {
      console.error("OffscreenManager: Failed to schedule close retry:", error);
    }
  }

  private async clearCloseRetryAlarm(): Promise<void> {
    if (!chrome.alarms?.clear) return;
    try {
      await Promise.resolve(
        chrome.alarms.clear(OFFSCREEN_CLOSE_RETRY_ALARM_NAME),
      );
    } catch (error) {
      console.warn(
        "OffscreenManager: Failed to clear close retry alarm:",
        error,
      );
    }
  }

  /**
   * Reset state (for testing)
   */
  public reset(): void {
    this.isCreated = false;
    this.isCreating = false;
    this.createPromise = null;
    this.closePromise = null;
    this.references.clear();
    this.totalReferences = 0;
    this.pendingOperations = 0;
    this.pendingPersistentUsers = 0;
    this.hasPersistentSharedUser = false;
  }
}

export const offscreenManager = OffscreenManager.getInstance();
