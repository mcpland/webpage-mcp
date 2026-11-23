import { readWithSignal } from './read-with-signal';

export interface BrowserInputContext {
  signal?: AbortSignal;
  deadlineAt?: number;
}

export function inputSignal(context?: BrowserInputContext): AbortSignal | undefined {
  const { signal, deadlineAt } = context ?? {};
  if (deadlineAt === undefined) return signal;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('Workflow input timed out');
  const timer = AbortSignal.timeout(Math.min(remaining, 2_147_483_647));
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

/** A renderer can ask whether its originating call is still live after awaiting page code. */
export async function withInputPermit<T>(
  tabId: number, frameId: number | undefined, signal: AbortSignal | undefined,
  dispatch: (permit?: string) => Promise<T>,
): Promise<T> {
  if (!signal) return dispatch();
  signal.throwIfAborted();
  const permit = crypto.randomUUID();
  const check = (message: { action?: string; permit?: string }, sender: chrome.runtime.MessageSender,
    respond: (value: boolean) => void) => {
    if (message?.action === 'checkBrowserInput' && message.permit === permit &&
        sender.tab?.id === tabId && sender.frameId === (frameId ?? 0)) {
      respond(!signal.aborted);
    }
  };
  chrome.runtime.onMessage.addListener(check);
  try {
    return await readWithSignal(() => dispatch(permit), signal);
  } finally {
    chrome.runtime.onMessage.removeListener(check);
  }
}
