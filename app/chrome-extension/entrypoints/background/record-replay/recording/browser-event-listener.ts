import { STEP_TYPES } from "@/common/step-types";
import {
  ensureRecorderInjected,
  broadcastControlToTab,
  REC_CMD,
} from "./content-injection";
import type { RecordingSessionManager } from "./session-manager";
import type { Step } from "../types";

interface TabEventTransaction {
  tabId: number;
  generation: number;
  sessionId: string;
  status: string;
  documentId?: string;
  token: symbol;
}

interface TabMutationOwner {
  token: symbol;
  sessionId: string;
  documentId: string;
  previousDocumentId?: string;
  removeOnFailure: boolean;
}

interface ActivationIntent {
  token: symbol;
  sessionId: string;
  requiresSwitchStep: true;
}

class StaleTabEventError extends Error {}

function normalizeDocumentId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : undefined;
}

export function initBrowserEventListeners(
  session: RecordingSessionManager,
): void {
  const tabGenerations = new Map<number, number>();
  const tabQueues = new Map<number, Promise<void>>();
  const activationIntents = new Map<number, ActivationIntent>();
  const mutationOwners = new Map<number, TabMutationOwner>();

  const captureTransaction = (
    tabId: number,
    documentId?: unknown,
  ): TabEventTransaction => {
    const generation = (tabGenerations.get(tabId) ?? 0) + 1;
    tabGenerations.set(tabId, generation);
    const current = session.getSession();
    return {
      tabId,
      generation,
      sessionId: current.sessionId,
      status: current.status,
      documentId: normalizeDocumentId(documentId),
      token: Symbol(`recording-tab-${tabId}-${generation}`),
    };
  };

  const isSameSession = (transaction: TabEventTransaction): boolean =>
    !!transaction.sessionId &&
    session.getSession().sessionId === transaction.sessionId;

  const isCurrent = (
    transaction: TabEventTransaction,
    documentId?: string,
  ): boolean => {
    if (
      transaction.status !== "recording" ||
      tabGenerations.get(transaction.tabId) !== transaction.generation
    ) {
      return false;
    }
    const current = session.getSession();
    if (
      !transaction.sessionId ||
      current.sessionId !== transaction.sessionId ||
      current.status !== "recording"
    ) {
      return false;
    }
    return (
      !documentId ||
      session.getActiveTabDocument(transaction.tabId) === documentId
    );
  };

  const requireCurrent = (
    transaction: TabEventTransaction,
    documentId?: string,
  ): void => {
    if (!isCurrent(transaction, documentId)) {
      throw new StaleTabEventError("recording tab event was superseded");
    }
  };

  const enqueueForTab = (
    transaction: TabEventTransaction,
    operation: () => Promise<void>,
  ): Promise<void> => {
    const previous = tabQueues.get(transaction.tabId) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(operation);
    tabQueues.set(transaction.tabId, queued);
    const cleanup = () => {
      if (tabQueues.get(transaction.tabId) !== queued) return;
      tabQueues.delete(transaction.tabId);
      if (tabGenerations.get(transaction.tabId) === transaction.generation) {
        tabGenerations.delete(transaction.tabId);
      }
    };
    void queued.then(cleanup, cleanup);
    return queued;
  };

  const getTopDocumentId = async (
    tabId: number,
  ): Promise<string | undefined> => {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      const top = Array.isArray(frames)
        ? frames.find((frame) => frame.frameId === 0)
        : undefined;
      return normalizeDocumentId(top?.documentId);
    } catch {
      return undefined;
    }
  };

  const getStartMeta = (expectedSessionId: string) => {
    const flow = session.getFlow();
    return {
      ...(flow?.id ? { id: flow.id } : {}),
      ...(flow?.name ? { name: flow.name } : {}),
      ...(flow?.description ? { description: flow.description } : {}),
      sessionId: expectedSessionId,
    };
  };

  const claimMutation = (
    transaction: TabEventTransaction,
    documentId: string,
    previousDocumentId: string | undefined,
    removeOnFailure: boolean,
  ): void => {
    mutationOwners.set(transaction.tabId, {
      token: transaction.token,
      sessionId: transaction.sessionId,
      documentId,
      previousDocumentId,
      removeOnFailure,
    });
  };

  const releaseMutation = (transaction: TabEventTransaction): void => {
    if (mutationOwners.get(transaction.tabId)?.token === transaction.token) {
      mutationOwners.delete(transaction.tabId);
    }
  };

  const rollbackMutation = async (
    transaction: TabEventTransaction,
    appendedStepIds: readonly string[],
  ): Promise<void> => {
    if (!isSameSession(transaction)) return;

    let mutated = false;
    for (let index = appendedStepIds.length - 1; index >= 0; index -= 1) {
      if (!session.rollbackLastStep(appendedStepIds[index])) break;
      mutated = true;
    }

    const owner = mutationOwners.get(transaction.tabId);
    if (
      owner?.token === transaction.token &&
      owner.sessionId === transaction.sessionId &&
      session.getActiveTabDocument(transaction.tabId) === owner.documentId
    ) {
      if (owner.removeOnFailure) {
        session.removeActiveTab(transaction.tabId);
      } else {
        session.setActiveTabDocument(
          transaction.tabId,
          owner.previousDocumentId,
        );
      }
      mutationOwners.delete(transaction.tabId);
      mutated = true;
    }

    if (mutated && isSameSession(transaction)) {
      await session.persistRecoveryState().catch(() => {});
      // Do not mutate after this await. A new session may now own the tab.
      void isSameSession(transaction);
    }
  };

  chrome.tabs.onActivated?.addListener((activeInfo) => {
    const transaction = captureTransaction(activeInfo.tabId);
    activationIntents.set(activeInfo.tabId, {
      token: transaction.token,
      sessionId: transaction.sessionId,
      requiresSwitchStep: true,
    });

    return enqueueForTab(transaction, async () => {
      const appendedStepIds: string[] = [];
      try {
        await session.waitUntilReady();
        requireCurrent(transaction);

        const documentId = await getTopDocumentId(transaction.tabId);
        requireCurrent(transaction);
        if (!documentId) {
          throw new Error(
            "top-frame document unavailable during tab activation",
          );
        }

        const wasTracked = session.hasActiveTab(transaction.tabId);
        if (!session.addActiveTab(transaction.tabId)) return;
        const newlyTracked = !wasTracked;
        const previousDocumentId = session.getActiveTabDocument(
          transaction.tabId,
        );
        session.setActiveTabDocument(transaction.tabId, documentId);
        claimMutation(
          transaction,
          documentId,
          previousDocumentId,
          newlyTracked,
        );

        await ensureRecorderInjected(transaction.tabId);
        requireCurrent(transaction, documentId);

        const flow = session.getFlow();
        if (!flow) {
          throw new Error("recording flow unavailable during tab activation");
        }
        const tab = await chrome.tabs.get(transaction.tabId);
        requireCurrent(transaction, documentId);
        const step: Step = {
          id: "",
          type: STEP_TYPES.SWITCH_TAB,
          ...(tab.url ? { urlContains: tab.url } : {}),
        };
        const appendResult = session.appendSteps([step]);
        if (appendResult.accepted > 0 && step.id) {
          appendedStepIds.push(step.id);
        }
        if (appendResult.truncated) {
          releaseMutation(transaction);
          return;
        }

        await session.persistRecoveryState();
        requireCurrent(transaction, documentId);
        const started = await broadcastControlToTab(
          transaction.tabId,
          REC_CMD.START,
          getStartMeta(transaction.sessionId),
          documentId,
        );
        requireCurrent(transaction, documentId);
        if (started === false) {
          throw new Error("top-frame recorder did not acknowledge START");
        }
        releaseMutation(transaction);
      } catch (error) {
        await rollbackMutation(transaction, appendedStepIds);
        if (!(error instanceof StaleTabEventError)) {
          console.warn("onActivated handler failed", error);
        }
      } finally {
        if (
          activationIntents.get(transaction.tabId)?.token === transaction.token
        ) {
          activationIntents.delete(transaction.tabId);
        }
      }
    });
  });

  chrome.webNavigation.onCommitted?.addListener((details) => {
    if (details.frameId !== 0) return;
    const transaction = captureTransaction(details.tabId, details.documentId);
    const activationIntent = activationIntents.get(details.tabId);
    const takeoverActivation =
      activationIntent?.sessionId === transaction.sessionId
        ? activationIntent
        : undefined;
    const shouldTrack =
      session.hasActiveTab(details.tabId) || takeoverActivation !== undefined;

    return enqueueForTab(transaction, async () => {
      const appendedStepIds: string[] = [];
      try {
        await session.waitUntilReady();
        requireCurrent(transaction);
        if (!shouldTrack) return;

        const wasTracked = session.hasActiveTab(transaction.tabId);
        if (!wasTracked && !session.addActiveTab(transaction.tabId)) return;
        const previousDocumentId = session.getActiveTabDocument(
          transaction.tabId,
        );
        const documentId =
          transaction.documentId ?? (await getTopDocumentId(transaction.tabId));
        requireCurrent(transaction);
        if (!documentId) {
          throw new Error("top-frame document unavailable after navigation");
        }
        session.setActiveTabDocument(transaction.tabId, documentId);
        claimMutation(transaction, documentId, previousDocumentId, true);

        const transitionType = details.transitionType;
        const shouldRecordNavigation =
          transitionType !== "link" &&
          (transitionType === "reload" ||
            transitionType === "typed" ||
            transitionType === "generated" ||
            transitionType === "auto_bookmark" ||
            transitionType === "keyword" ||
            transitionType === "form_submit");
        const shouldMaterializeSwitch =
          takeoverActivation?.requiresSwitchStep === true;
        const backgroundSteps: Step[] = [];
        if (shouldMaterializeSwitch || shouldRecordNavigation) {
          const tab = await chrome.tabs.get(transaction.tabId);
          requireCurrent(transaction, documentId);
          const url = tab.url || details.url;
          if (shouldMaterializeSwitch) {
            backgroundSteps.push({
              id: "",
              type: STEP_TYPES.SWITCH_TAB,
              ...(url ? { urlContains: url } : {}),
            });
          }
          if (shouldRecordNavigation && session.getFlow() && url) {
            backgroundSteps.push({
              id: "",
              type: STEP_TYPES.NAVIGATE,
              url,
            } as Step);
          }
        }
        if (backgroundSteps.length > 0) {
          const appendResult = session.appendSteps(backgroundSteps);
          const acceptedCount = Math.min(
            appendResult.accepted,
            backgroundSteps.length,
          );
          appendedStepIds.push(
            ...backgroundSteps
              .slice(0, acceptedCount)
              .map((step) => step.id)
              .filter((stepId): stepId is string => !!stepId),
          );
          if (appendResult.truncated) {
            // A limit-triggered stop owns the accepted prefix. Leave that
            // prefix and the newest document membership intact.
            releaseMutation(transaction);
            return;
          }
        }

        await session.persistRecoveryState();
        requireCurrent(transaction, documentId);
        await ensureRecorderInjected(transaction.tabId);
        requireCurrent(transaction, documentId);
        const started = await broadcastControlToTab(
          transaction.tabId,
          REC_CMD.START,
          getStartMeta(transaction.sessionId),
          documentId,
        );
        requireCurrent(transaction, documentId);
        if (started === false) {
          throw new Error("top-frame recorder did not acknowledge START");
        }

        if (session.getFlow()) session.broadcastTimelineUpdate();
        releaseMutation(transaction);
      } catch (error) {
        await rollbackMutation(transaction, appendedStepIds);
        if (!(error instanceof StaleTabEventError)) {
          console.warn("onCommitted handler failed", error);
        }
      }
    });
  });

  chrome.tabs.onRemoved?.addListener((tabId) => {
    const transaction = captureTransaction(
      tabId,
      session.getActiveTabDocument(tabId),
    );
    return enqueueForTab(transaction, async () => {
      if (
        !transaction.sessionId ||
        transaction.status === "idle" ||
        tabGenerations.get(tabId) !== transaction.generation ||
        !isSameSession(transaction)
      ) {
        return;
      }
      mutationOwners.delete(tabId);
      activationIntents.delete(tabId);
      session.removeActiveTab(tabId);
      await session.persistRecoveryState().catch(() => {});
      // Do not mutate after this await. A new session may now own the tab.
      void isSameSession(transaction);
    });
  });
}
