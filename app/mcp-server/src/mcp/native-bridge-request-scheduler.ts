import type { NativeBridgeRequestClient } from './native-ipc-bridge-client';

export const NATIVE_BRIDGE_SCHEDULER_MAX_IN_FLIGHT = 12;
export const NATIVE_BRIDGE_SCHEDULER_MAX_IN_FLIGHT_PER_SESSION = 4;
export const NATIVE_BRIDGE_SCHEDULER_MAX_QUEUED = 128;
export const NATIVE_BRIDGE_SCHEDULER_MAX_QUEUED_PER_SESSION = 32;

const UNSCOPED_SESSION_KEY = '__webpage_mcp_control__';

export interface NativeBridgeRequestSchedulerOptions {
  maxInFlight?: number;
  maxInFlightPerSession?: number;
  maxQueued?: number;
  maxQueuedPerSession?: number;
  now?: () => number;
}

interface ScheduledBridgeRequest {
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly timeoutMs: number;
  readonly deadline: number;
  readonly sessionKey: string;
  readonly signal?: AbortSignal;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  queueTimer?: NodeJS.Timeout;
  abortHandler?: () => void;
}

function createAbortError(): Error {
  const error = new Error('MCP request cancelled');
  error.name = 'AbortError';
  return error;
}

function sessionKeyFor(params?: Record<string, unknown>): string {
  const sessionId = params?.sessionId;
  return typeof sessionId === 'string' && sessionId.trim()
    ? sessionId.trim()
    : UNSCOPED_SESSION_KEY;
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export class NativeBridgeRequestScheduler implements NativeBridgeRequestClient {
  private readonly maxInFlight: number;
  private readonly maxInFlightPerSession: number;
  private readonly maxQueued: number;
  private readonly maxQueuedPerSession: number;
  private readonly now: () => number;
  private readonly queues = new Map<string, ScheduledBridgeRequest[]>();
  private readonly rotation: string[] = [];
  private readonly sessionsInRotation = new Set<string>();
  private readonly inFlightBySession = new Map<string, number>();
  private readonly closeController = new AbortController();
  private queued = 0;
  private inFlight = 0;
  private closed = false;

  public constructor(
    private readonly delegate: NativeBridgeRequestClient,
    options: NativeBridgeRequestSchedulerOptions = {},
  ) {
    this.maxInFlight = options.maxInFlight ?? NATIVE_BRIDGE_SCHEDULER_MAX_IN_FLIGHT;
    this.maxInFlightPerSession =
      options.maxInFlightPerSession ?? NATIVE_BRIDGE_SCHEDULER_MAX_IN_FLIGHT_PER_SESSION;
    this.maxQueued = options.maxQueued ?? NATIVE_BRIDGE_SCHEDULER_MAX_QUEUED;
    this.maxQueuedPerSession =
      options.maxQueuedPerSession ?? NATIVE_BRIDGE_SCHEDULER_MAX_QUEUED_PER_SESSION;
    this.now = options.now || Date.now;

    validatePositiveInteger(this.maxInFlight, 'maxInFlight');
    validatePositiveInteger(this.maxInFlightPerSession, 'maxInFlightPerSession');
    validatePositiveInteger(this.maxQueued, 'maxQueued');
    validatePositiveInteger(this.maxQueuedPerSession, 'maxQueuedPerSession');
    if (this.maxInFlightPerSession > this.maxInFlight) {
      throw new Error('maxInFlightPerSession may not exceed maxInFlight');
    }
  }

  public request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Native bridge scheduler closed'));
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error('Native bridge request timeout must be positive'));
    }

    const sessionKey = sessionKeyFor(params);
    const queue = this.queues.get(sessionKey) || [];
    if (this.queued >= this.maxQueued) {
      return Promise.reject(
        new Error(`Native bridge request queue has reached its ${this.maxQueued}-request limit`),
      );
    }
    if (queue.length >= this.maxQueuedPerSession) {
      return Promise.reject(
        new Error(
          `Native bridge session queue has reached its ${this.maxQueuedPerSession}-request limit`,
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const request: ScheduledBridgeRequest = {
        method,
        params,
        timeoutMs,
        deadline: this.now() + timeoutMs,
        sessionKey,
        signal,
        resolve: (value: unknown) => resolve(value as T),
        reject,
      };
      request.queueTimer = setTimeout(() => {
        if (!this.removeQueuedRequest(request)) return;
        request.reject(new Error(`Native bridge request timed out after ${timeoutMs}ms`));
        this.drain();
      }, timeoutMs);
      request.queueTimer.unref();
      if (signal) {
        request.abortHandler = () => {
          if (!this.removeQueuedRequest(request)) return;
          request.reject(createAbortError());
          this.drain();
        };
        signal.addEventListener('abort', request.abortHandler, { once: true });
      }

      queue.push(request);
      this.queues.set(sessionKey, queue);
      this.queued += 1;
      this.addSessionToRotation(sessionKey);
      if (signal?.aborted && request.abortHandler) {
        request.abortHandler();
        return;
      }
      this.drain();
    });
  }

  private addSessionToRotation(sessionKey: string): void {
    if (this.sessionsInRotation.has(sessionKey)) return;
    this.sessionsInRotation.add(sessionKey);
    this.rotation.push(sessionKey);
  }

  private removeSessionFromRotation(sessionKey: string): void {
    if (!this.sessionsInRotation.delete(sessionKey)) return;
    const index = this.rotation.indexOf(sessionKey);
    if (index >= 0) this.rotation.splice(index, 1);
  }

  private removeQueuedRequest(request: ScheduledBridgeRequest): boolean {
    const queue = this.queues.get(request.sessionKey);
    if (!queue) return false;
    const index = queue.indexOf(request);
    if (index < 0) return false;
    queue.splice(index, 1);
    this.queued -= 1;
    clearTimeout(request.queueTimer);
    if (request.signal && request.abortHandler) {
      request.signal.removeEventListener('abort', request.abortHandler);
    }
    if (queue.length === 0) {
      this.queues.delete(request.sessionKey);
      this.removeSessionFromRotation(request.sessionKey);
    }
    return true;
  }

  private takeNextRequest(): ScheduledBridgeRequest | undefined {
    const candidates = this.rotation.length;
    for (let index = 0; index < candidates; index += 1) {
      const sessionKey = this.rotation.shift();
      if (!sessionKey) return undefined;
      this.sessionsInRotation.delete(sessionKey);
      const queue = this.queues.get(sessionKey);
      if (!queue?.length) {
        this.queues.delete(sessionKey);
        continue;
      }

      if ((this.inFlightBySession.get(sessionKey) || 0) >= this.maxInFlightPerSession) {
        this.addSessionToRotation(sessionKey);
        continue;
      }

      const request = queue.shift()!;
      this.queued -= 1;
      clearTimeout(request.queueTimer);
      if (request.signal && request.abortHandler) {
        request.signal.removeEventListener('abort', request.abortHandler);
      }
      if (queue.length === 0) {
        this.queues.delete(sessionKey);
      } else {
        this.addSessionToRotation(sessionKey);
      }
      return request;
    }
    return undefined;
  }

  private drain(): void {
    if (this.closed) return;
    while (this.inFlight < this.maxInFlight) {
      const request = this.takeNextRequest();
      if (!request) return;
      const remainingMs = request.deadline - this.now();
      if (remainingMs <= 0) {
        request.reject(new Error(`Native bridge request timed out after ${request.timeoutMs}ms`));
        continue;
      }
      this.dispatch(request, remainingMs);
    }
  }

  private dispatch(request: ScheduledBridgeRequest, remainingMs: number): void {
    this.inFlight += 1;
    this.inFlightBySession.set(
      request.sessionKey,
      (this.inFlightBySession.get(request.sessionKey) || 0) + 1,
    );

    const dispatchController = new AbortController();
    const abortDispatch = (): void => dispatchController.abort();
    request.signal?.addEventListener('abort', abortDispatch, { once: true });
    this.closeController.signal.addEventListener('abort', abortDispatch, { once: true });
    if (request.signal?.aborted || this.closeController.signal.aborted) abortDispatch();

    void Promise.resolve()
      .then(() =>
        this.delegate.request(
          request.method,
          request.params,
          Math.max(1, Math.ceil(remainingMs)),
          dispatchController.signal,
        ),
      )
      .then(request.resolve, request.reject)
      .finally(() => {
        request.signal?.removeEventListener('abort', abortDispatch);
        this.closeController.signal.removeEventListener('abort', abortDispatch);
        this.inFlight = Math.max(0, this.inFlight - 1);
        const sessionInFlight = (this.inFlightBySession.get(request.sessionKey) || 1) - 1;
        if (sessionInFlight <= 0) {
          this.inFlightBySession.delete(request.sessionKey);
        } else {
          this.inFlightBySession.set(request.sessionKey, sessionInFlight);
        }
        this.drain();
      });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeController.abort();
    for (const queue of this.queues.values()) {
      for (const request of queue) {
        clearTimeout(request.queueTimer);
        if (request.signal && request.abortHandler) {
          request.signal.removeEventListener('abort', request.abortHandler);
        }
        request.reject(new Error('Native bridge scheduler closed'));
      }
    }
    this.queues.clear();
    this.rotation.length = 0;
    this.sessionsInRotation.clear();
    this.queued = 0;
  }
}
