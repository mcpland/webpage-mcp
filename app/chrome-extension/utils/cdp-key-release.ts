import { cdpSessionManager } from "./cdp-session-manager";
import { readWithSignal } from "./read-with-signal";
import {
  guardNewKeyDocument,
  prepareNativeKeyRelease,
  type PendingKeyRelease,
} from "./cancelled-keys";

export interface NativeKeyRelease extends PendingKeyRelease {
  key: string;
  location: number;
  windowsVirtualKeyCode: number;
}

// Out-of-process iframes have their own Page domain. Pause new iframe targets
// before page scripts, install the same preload there, then resume them.
function guardKeyReleaseFrames(
  tabId: number,
  preload: { source: string; worldName: string },
  changed: AbortController,
  sameSession: () => boolean,
) {
  const options = {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "iframe" }, { exclude: true }],
  };
  const children = new Set<string>();
  const pending = new Set<Promise<void>>();
  let closed = false;
  const onTarget = (
    parent: chrome.debugger.DebuggerSession,
    method: string,
    params?: object,
  ) => {
    if (
      closed ||
      parent.tabId !== tabId ||
      (parent.sessionId && !children.has(parent.sessionId)) ||
      method !== "Target.attachedToTarget"
    )
      return;
    const { sessionId, targetInfo, waitingForDebugger } = params as {
      sessionId: string;
      targetInfo: { type: string };
      waitingForDebugger: boolean;
    };
    if (targetInfo.type !== "iframe") return;
    children.add(sessionId);
    const child = { tabId, sessionId };
    const protect = async () => {
      await chrome.debugger.sendCommand(child, "Page.enable");
      if (closed) return;
      await chrome.debugger.sendCommand(
        child,
        "Page.addScriptToEvaluateOnNewDocument",
        { ...preload, runImmediately: waitingForDebugger },
      );
      if (closed) return;
      await chrome.debugger.sendCommand(child, "Target.setAutoAttach", options);
      if (waitingForDebugger && !closed)
        await chrome.debugger.sendCommand(
          child,
          "Runtime.runIfWaitingForDebugger",
        );
    };
    const task = protect().catch(() => changed.abort());
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  chrome.debugger.onEvent.addListener(onTarget);
  return {
    async start() {
      await chrome.debugger.sendCommand(
        { tabId },
        "Target.setAutoAttach",
        options,
      );
      while (!closed && pending.size) await Promise.all(pending);
    },
    async stop() {
      closed = true;
      chrome.debugger.onEvent.removeListener(onTarget);
      // Disabling auto-attach detaches children, including any still paused.
      if (sameSession())
        await readWithSignal(
          () =>
            chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", {
              autoAttach: false,
              waitForDebuggerOnStart: false,
              flatten: true,
            }),
          AbortSignal.timeout(1500),
        ).catch(() => {});
    },
  };
}

// A late native acknowledgement may outlive the regular per-tab input queue.
const activeKeyRecoveries = new Set<number>();

export async function releaseFocusedKeys(
  tabId: number,
  token: string,
  keys: NativeKeyRelease[],
) {
  if (!chrome.webNavigation?.getAllFrames || activeKeyRecoveries.has(tabId))
    return;
  const changed = new AbortController();
  const deadline = AbortSignal.any([AbortSignal.timeout(5000), changed.signal]);
  const navigation = chrome.webNavigation;
  const onNavigation = (event: { tabId: number }) => {
    if (event.tabId === tabId) changed.abort();
  };
  navigation.onBeforeNavigate?.addListener(onNavigation);
  navigation.onCommitted?.addListener(onNavigation);
  const recover = () =>
    cdpSessionManager.withSession(
      tabId,
      Symbol("cancelled chord"),
      async (sameSession) => {
        deadline.throwIfAborted();
        const target = { tabId };
        const timestamp = Date.now();
        const expires = timestamp + 60_000;
        const args = [keys.map((key) => key.code), timestamp, expires].map(
          (value) => JSON.stringify(value),
        );
        // Keep one debugger session for the preload and the native input. A new
        // document (including a synchronous about:blank iframe) must reject this batch.
        let detached = false;
        const onDetach = (source: chrome.debugger.Debuggee) => {
          if (source.tabId === tabId) {
            detached = true;
            changed.abort();
          }
        };
        chrome.debugger.onDetach.addListener(onDetach);
        const lifetime = AbortSignal.timeout(60_000);
        let identifier: string | undefined;
        const unregister = async (id?: string) => {
          if (id && !detached && sameSession()) {
            await readWithSignal(
              () =>
                chrome.debugger.sendCommand(
                  target,
                  "Page.removeScriptToEvaluateOnNewDocument",
                  { identifier: id },
                ),
              AbortSignal.timeout(1500),
            ).catch(() => {});
          }
        };
        const preload = {
          source: `(${guardNewKeyDocument.toString()})(${args.join(",")})`,
          worldName: "webpage-mcp-key-release",
        };
        let frameGuards: ReturnType<typeof guardKeyReleaseFrames> | undefined;
        const registration = (async () => {
          await chrome.debugger.sendCommand(target, "Page.enable");
          deadline.throwIfAborted();
          return chrome.debugger.sendCommand(
            target,
            "Page.addScriptToEvaluateOnNewDocument",
            preload,
          );
        })() as Promise<{ identifier?: string }>;
        try {
          identifier = (await readWithSignal(() => registration, deadline))
            .identifier;
          if (!identifier || activeKeyRecoveries.has(tabId)) return;
          frameGuards = guardKeyReleaseFrames(
            tabId,
            preload,
            changed,
            sameSession,
          );
          activeKeyRecoveries.add(tabId);
          await readWithSignal(frameGuards.start, deadline);
          for (const key of keys) {
            deadline.throwIfAborted();
            const guards = await readWithSignal(
              () =>
                chrome.scripting.executeScript({
                  target: { tabId, allFrames: true },
                  world: "ISOLATED",
                  injectImmediately: true,
                  func: prepareNativeKeyRelease,
                  args: [token, key, timestamp],
                }),
              deadline,
            );
            if (
              guards.filter((frame) => frame.result === "focused").length !== 1
            )
              return;
            const frames = await readWithSignal(
              () => navigation.getAllFrames({ tabId }),
              deadline,
            );
            const ready = new Set(
              guards
                .filter(
                  (frame) =>
                    frame.result === "focused" || frame.result === "guarded",
                )
                .map((frame) => frame.documentId),
            );
            if (
              !frames?.length ||
              !frames.every(
                (frame) => frame.documentId && ready.has(frame.documentId),
              )
            )
              return;
            deadline.throwIfAborted();
            // Submit directly on the leased session. Retrying a release across a
            // debugger detach would lose the new-document guard.
            const reply = chrome.debugger.sendCommand(
              target,
              "Input.dispatchKeyEvent",
              {
                type: "keyUp",
                key: key.key,
                code: key.code,
                location: key.location,
                modifiers: key.modifiers,
                windowsVirtualKeyCode: key.windowsVirtualKeyCode,
                timestamp: timestamp / 1000,
              },
            );
            key.awaitingNativeAck = true;
            await readWithSignal(() => reply, lifetime);
            key.awaitingNativeAck = false;
          }
        } finally {
          chrome.debugger.onDetach.removeListener(onDetach);
          if (frameGuards) {
            try {
              await frameGuards.stop();
            } finally {
              activeKeyRecoveries.delete(tabId);
            }
          }
          if (identifier) await unregister(identifier);
          else
            void registration
              .then((result) => unregister(result.identifier))
              .catch(() => {});
        }
      },
    );
  try {
    await readWithSignal(recover, deadline);
  } finally {
    navigation.onBeforeNavigate?.removeListener(onNavigation);
    navigation.onCommitted?.removeListener(onNavigation);
  }
}
