import type { CSSProperties as ReactCSSProperties } from 'react';

type CleanupFn = () => void;

export type CSSProperties = ReactCSSProperties;
export type InjectionKey<T> = symbol & { __type?: T };

export interface Ref<T> {
  value: T;
}

export type ComputedRef<T> = Readonly<Ref<T>>;

export type WatchSource<T = unknown> = Ref<T> | (() => T);

export interface WatchOptions {
  immediate?: boolean;
  deep?: boolean;
  flush?: 'pre' | 'post' | 'sync';
}

type WatchCallback<T> = (
  value: T,
  oldValue: T | undefined,
  onCleanup: (fn: CleanupFn) => void,
) => void;

interface Watcher<T> {
  source: () => T;
  callback: WatchCallback<T>;
  deep: boolean;
  cleanup: CleanupFn | null;
  stopped: boolean;
  initialized: boolean;
  value: T | undefined;
  snapshot: string | undefined;
}

const watchers = new Set<Watcher<unknown>>();
let flushQueued = false;
let unmountHookRegistered = false;
const unmountCallbacks = new Set<CleanupFn>();

const rawToProxy = new WeakMap<object, object>();
const proxyToRaw = new WeakMap<object, object>();

function canObserve(value: unknown): value is object {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof Promise ||
    value instanceof Error ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return false;
  }
  return true;
}

function toReactive<T>(value: T): T {
  if (canObserve(value)) {
    return reactive(value) as T;
  }
  return value;
}

function queueFlush(): void {
  if (flushQueued) {
    return;
  }
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    flushWatchers();
  });
}

function triggerReactivity(): void {
  queueFlush();
}

function normalizeForSnapshot(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  if (typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof RegExp) {
    return value.toString();
  }

  if (value instanceof Map) {
    return {
      map: Array.from(value.entries()).map(([k, v]) => [
        normalizeForSnapshot(k, seen),
        normalizeForSnapshot(v, seen),
      ]),
    };
  }

  if (value instanceof Set) {
    return {
      set: Array.from(value.values()).map((item) => normalizeForSnapshot(item, seen)),
    };
  }

  const raw = proxyToRaw.get(value as object) ?? (value as object);
  if (seen.has(raw)) {
    return '[Circular]';
  }
  seen.add(raw);

  if (Array.isArray(raw)) {
    return raw.map((item) => normalizeForSnapshot(item, seen));
  }

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(raw).sort()) {
    normalized[key] = normalizeForSnapshot((raw as Record<string, unknown>)[key], seen);
  }
  return normalized;
}

function createSnapshot(value: unknown): string {
  try {
    return JSON.stringify(normalizeForSnapshot(value));
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

function evaluateWatcher<T>(watcher: Watcher<T>): void {
  if (watcher.stopped) {
    return;
  }

  const nextValue = watcher.source();

  if (!watcher.initialized) {
    watcher.initialized = true;
    watcher.value = nextValue;
    if (watcher.deep) {
      watcher.snapshot = createSnapshot(nextValue);
    }
    return;
  }

  let changed = false;
  if (watcher.deep) {
    const nextSnapshot = createSnapshot(nextValue);
    changed = watcher.snapshot !== nextSnapshot;
    watcher.snapshot = nextSnapshot;
  } else {
    changed = !Object.is(watcher.value, nextValue);
  }

  if (!changed) {
    return;
  }

  const previousValue = watcher.value;
  watcher.value = nextValue;

  if (watcher.cleanup) {
    try {
      watcher.cleanup();
    } finally {
      watcher.cleanup = null;
    }
  }

  let registeredCleanup: CleanupFn | null = null;
  const onCleanup = (fn: CleanupFn): void => {
    registeredCleanup = fn;
  };

  watcher.callback(nextValue, previousValue, onCleanup);
  watcher.cleanup = registeredCleanup;
}

function flushWatchers(): void {
  const list = Array.from(watchers);
  for (const watcher of list) {
    evaluateWatcher(watcher as Watcher<unknown>);
  }
}

function createRef<T>(initialValue: T, deep: boolean): Ref<T> {
  let innerValue = deep ? toReactive(initialValue) : initialValue;
  return {
    get value() {
      return innerValue;
    },
    set value(nextValue: T) {
      const prepared = deep ? toReactive(nextValue) : nextValue;
      if (Object.is(innerValue, prepared)) {
        return;
      }
      innerValue = prepared;
      triggerReactivity();
    },
  };
}

export function ref<T>(value: T): Ref<T> {
  return createRef(value, true);
}

export function shallowRef<T>(value: T): Ref<T> {
  return createRef(value, false);
}

export function reactive<T extends object>(target: T): T {
  if (!canObserve(target)) {
    return target;
  }

  if (proxyToRaw.has(target)) {
    return target;
  }

  const existing = rawToProxy.get(target);
  if (existing) {
    return existing as T;
  }

  const proxy = new Proxy(target, {
    get(obj, key, receiver) {
      const value = Reflect.get(obj, key, receiver);
      return canObserve(value) ? reactive(value) : value;
    },
    set(obj, key, value, receiver) {
      const previous = Reflect.get(obj, key, receiver);
      const prepared = canObserve(value) ? reactive(value) : value;
      const changed = !Object.is(previous, prepared);
      const result = Reflect.set(obj, key, prepared, receiver);
      if (changed) {
        triggerReactivity();
      }
      return result;
    },
    deleteProperty(obj, key) {
      const hadKey = Reflect.has(obj, key);
      const result = Reflect.deleteProperty(obj, key);
      if (hadKey && result) {
        triggerReactivity();
      }
      return result;
    },
  });

  rawToProxy.set(target, proxy);
  proxyToRaw.set(proxy, target);
  return proxy as T;
}

export function computed<T>(getter: () => T): ComputedRef<T> {
  return {
    get value() {
      return getter();
    },
  };
}

export function watch<T>(
  source: WatchSource<T>,
  callback: WatchCallback<T>,
  options: WatchOptions = {},
): () => void {
  const getter = (typeof source === 'function' ? source : () => source.value) as () => T;

  const watcher: Watcher<T> = {
    source: getter,
    callback,
    deep: options.deep === true,
    cleanup: null,
    stopped: false,
    initialized: false,
    value: undefined,
    snapshot: undefined,
  };

  watchers.add(watcher as Watcher<unknown>);

  if (options.immediate) {
    const nextValue = watcher.source();
    watcher.initialized = true;
    watcher.value = nextValue;
    if (watcher.deep) {
      watcher.snapshot = createSnapshot(nextValue);
    }
    let registeredCleanup: CleanupFn | null = null;
    const onCleanup = (fn: CleanupFn): void => {
      registeredCleanup = fn;
    };
    watcher.callback(nextValue, undefined, onCleanup);
    watcher.cleanup = registeredCleanup;
  } else {
    const nextValue = watcher.source();
    watcher.initialized = true;
    watcher.value = nextValue;
    if (watcher.deep) {
      watcher.snapshot = createSnapshot(nextValue);
    }
  }

  const stop = (): void => {
    if (watcher.stopped) {
      return;
    }
    watcher.stopped = true;
    watchers.delete(watcher as Watcher<unknown>);
    if (watcher.cleanup) {
      try {
        watcher.cleanup();
      } finally {
        watcher.cleanup = null;
      }
    }
  };

  return stop;
}

function registerGlobalUnmountHook(): void {
  if (unmountHookRegistered || typeof window === 'undefined') {
    return;
  }
  unmountHookRegistered = true;

  const run = () => {
    const callbacks = Array.from(unmountCallbacks);
    unmountCallbacks.clear();
    for (const callback of callbacks) {
      try {
        callback();
      } catch {
        continue;
      }
    }
  };

  window.addEventListener('pagehide', run, { once: true });
  window.addEventListener('beforeunload', run, { once: true });
}

export function onMounted(callback: CleanupFn): void {
  queueMicrotask(callback);
}

export function onUnmounted(callback: CleanupFn): void {
  registerGlobalUnmountHook();
  unmountCallbacks.add(callback);
}

export function nextTick(): Promise<void> {
  return Promise.resolve();
}
