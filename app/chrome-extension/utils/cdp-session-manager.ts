type OwnerTag = string;

interface TabSessionState {
  owners: Map<OwnerTag, number>;
  attachedByUs: boolean;
}

type DebuggerApi = Pick<
  typeof chrome.debugger,
  "attach" | "detach" | "getTargets" | "onDetach" | "sendCommand"
>;

const DEBUGGER_PROTOCOL_VERSION = "1.3";
const ATTACH_ATTEMPTS = 2;

function isDefinitelyDetachedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /debugger is not attached/i.test(message) ||
    /no debugger is attached/i.test(message) ||
    /not attached to (?:the )?tab/i.test(message)
  );
}

export class CDPSessionManager {
  private readonly sessions = new Map<number, TabSessionState>();
  private readonly operationTails = new Map<number, Promise<void>>();
  private readonly detachGenerations = new Map<number, number>();
  private readonly pendingLocalDetachEvents = new Map<number, number>();
  private readonly listenerApi?: DebuggerApi;

  constructor(private readonly configuredDebuggerApi?: DebuggerApi) {
    this.listenerApi =
      configuredDebuggerApi ??
      (typeof chrome !== "undefined"
        ? (chrome.debugger as DebuggerApi | undefined)
        : undefined);
    this.listenerApi?.onDetach?.addListener(this.handleDebuggerDetach);
  }

  dispose(): void {
    this.listenerApi?.onDetach?.removeListener(this.handleDebuggerDetach);
    this.sessions.clear();
    this.detachGenerations.clear();
    this.pendingLocalDetachEvents.clear();
  }

  private getDebuggerApi(): DebuggerApi {
    const api =
      this.configuredDebuggerApi ??
      (typeof chrome !== "undefined"
        ? (chrome.debugger as DebuggerApi | undefined)
        : undefined);
    if (!api) {
      throw new Error("chrome.debugger API is unavailable");
    }
    return api;
  }

  private getState(tabId: number): TabSessionState | undefined {
    return this.sessions.get(tabId);
  }

  private getDetachGeneration(tabId: number): number {
    return this.detachGenerations.get(tabId) ?? 0;
  }

  private incrementOwner(state: TabSessionState, owner: OwnerTag): void {
    state.owners.set(owner, (state.owners.get(owner) ?? 0) + 1);
  }

  private clearState(tabId: number, expectedState?: TabSessionState): void {
    if (expectedState && this.sessions.get(tabId) !== expectedState) {
      return;
    }
    this.sessions.delete(tabId);
  }

  private markLocalDetach(tabId: number): void {
    this.pendingLocalDetachEvents.set(
      tabId,
      (this.pendingLocalDetachEvents.get(tabId) ?? 0) + 1,
    );
  }

  private consumeLocalDetach(tabId: number): boolean {
    const pending = this.pendingLocalDetachEvents.get(tabId) ?? 0;
    if (pending === 0) {
      return false;
    }
    if (pending === 1) {
      this.pendingLocalDetachEvents.delete(tabId);
    } else {
      this.pendingLocalDetachEvents.set(tabId, pending - 1);
    }
    return true;
  }

  private readonly handleDebuggerDetach = (
    source: chrome.debugger.Debuggee,
    reason: `${chrome.debugger.DetachReason}`,
  ): void => {
    const tabId = source.tabId;
    if (typeof tabId !== "number") {
      return;
    }

    // chrome.debugger.detach() may resolve before Chrome dispatches onDetach.
    // Consume that known notification without clearing a newer attachment that
    // a queued owner acquired in the meantime.
    if (reason === "canceled_by_user" && this.consumeLocalDetach(tabId)) {
      return;
    }
    this.pendingLocalDetachEvents.delete(tabId);

    // Browser detach events are authoritative. Clear all owner leases
    // synchronously so no later detach can act on stale state.
    this.sessions.delete(tabId);

    // An external detach can interleave with getTargets()/attach(). The
    // generation lets the in-flight operation detect that its observation is
    // stale before publishing a new session state.
    if (this.operationTails.has(tabId)) {
      this.detachGenerations.set(tabId, this.getDetachGeneration(tabId) + 1);
    } else {
      this.detachGenerations.delete(tabId);
    }
  };

  private runSerialized<T>(
    tabId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.operationTails.get(tabId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.operationTails.set(tabId, tail);

    return result.finally(() => {
      if (this.operationTails.get(tabId) !== tail) {
        return;
      }
      this.operationTails.delete(tabId);
      if (!this.sessions.has(tabId)) {
        this.detachGenerations.delete(tabId);
      }
    });
  }

  async attach(tabId: number, owner: OwnerTag = "unknown"): Promise<void> {
    await this.runSerialized(tabId, async () => {
      const current = this.getState(tabId);
      if (current?.attachedByUs) {
        this.incrementOwner(current, owner);
        return;
      }

      for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt += 1) {
        const debuggerApi = this.getDebuggerApi();
        const generation = this.getDetachGeneration(tabId);
        const targets = await debuggerApi.getTargets();

        if (generation !== this.getDetachGeneration(tabId)) {
          continue;
        }

        const existing = targets.find(
          (target) => target.tabId === tabId && target.attached,
        );
        if (existing) {
          if (existing.extensionId !== chrome.runtime.id) {
            throw new Error(
              `Debugger is already attached to tab ${tabId} by another client (e.g., DevTools/extension)`,
            );
          }

          this.sessions.set(tabId, {
            owners: new Map([[owner, 1]]),
            attachedByUs: true,
          });
          return;
        }

        await debuggerApi.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
        if (generation !== this.getDetachGeneration(tabId)) {
          continue;
        }

        this.sessions.set(tabId, {
          owners: new Map([[owner, 1]]),
          attachedByUs: true,
        });
        return;
      }

      throw new Error(`Debugger detached while attaching to tab ${tabId}`);
    });
  }

  async detach(tabId: number, owner: OwnerTag = "unknown"): Promise<void> {
    await this.runSerialized(tabId, async () => {
      const state = this.getState(tabId);
      if (!state) {
        return;
      }

      const ownerCount = state.owners.get(owner);
      if (!ownerCount) {
        // A caller cannot release another owner's lease.
        return;
      }

      if (ownerCount > 1) {
        state.owners.set(owner, ownerCount - 1);
        return;
      }
      state.owners.delete(owner);

      if (state.owners.size > 0) {
        return;
      }

      // Remove state before awaiting Chrome. Its onDetach notification may be
      // delivered synchronously or asynchronously, and both paths must observe
      // an already-cleared lease set.
      this.sessions.delete(tabId);
      try {
        if (state.attachedByUs) {
          this.markLocalDetach(tabId);
          try {
            await this.getDebuggerApi().detach({ tabId });
          } catch (error) {
            // A failed detach does not have a corresponding local notification.
            this.consumeLocalDetach(tabId);
            throw error;
          }
        }
      } catch {
        // The tab may already be closed or forcibly detached. State is still
        // cleared so a later attach re-checks the browser as the source of truth.
      }
    });
  }

  /**
   * Convenience wrapper: ensures attach before fn, and balanced detach after.
   */
  async withSession<T>(
    tabId: number,
    owner: OwnerTag,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.attach(tabId, owner);
    try {
      return await fn();
    } finally {
      await this.detach(tabId, owner);
    }
  }

  /**
   * Send a CDP command while holding a short-lived owner lease. If Chrome
   * definitively reports that no debugger is attached, discard only the state
   * used by this command, reattach, and retry once. Ambiguous failures are never
   * retried because CDP commands can have side effects.
   */
  async sendCommand<T = any>(
    tabId: number,
    method: string,
    params?: object,
  ): Promise<T> {
    const owner = `send:${method}`;
    await this.attach(tabId, owner);
    let commandState = this.getState(tabId);
    let hasCommandLease = true;

    try {
      try {
        return (await this.getDebuggerApi().sendCommand(
          { tabId },
          method,
          params,
        )) as T;
      } catch (error) {
        if (!isDefinitelyDetachedError(error)) {
          throw error;
        }

        this.clearState(tabId, commandState);
        hasCommandLease = false;

        await this.attach(tabId, owner);
        commandState = this.getState(tabId);
        hasCommandLease = true;
        return (await this.getDebuggerApi().sendCommand(
          { tabId },
          method,
          params,
        )) as T;
      }
    } finally {
      if (hasCommandLease) {
        await this.detach(tabId, owner);
      }
    }
  }
}

export const cdpSessionManager = new CDPSessionManager();
