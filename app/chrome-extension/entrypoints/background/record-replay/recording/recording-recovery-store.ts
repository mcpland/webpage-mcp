import type { Flow, Step } from "../types";

export const RECORDING_RECOVERY_VERSION = 1;
export const RECORDING_RECOVERY_ALARM = "rr-recording-recovery-deadline-v1";
export const RECORDING_RECOVERY_SESSION_KEY = "rr-recording-recovery-lease-v1";

const DB_NAME = "rr-recording-recovery";
const DB_VERSION = 1;
const STORE_NAME = "checkpoints";
const ACTIVE_CHECKPOINT_KEY = "active";

export interface RecordingRecoverySourceState {
  sourceKey: string;
  highWatermarkSeq: number;
  updatedAt: number;
}

export interface RecordingRecoveryPendingFrameStep {
  tabId: number;
  eventId: string;
  step: Step;
  href: string;
  createdAt: number;
}

export interface RecordingRecoveryIngestState {
  sessionId: string;
  sources: RecordingRecoverySourceState[];
  pendingFrameSteps: RecordingRecoveryPendingFrameStep[];
  lastStepByTab: Array<[number, string]>;
}

export interface RecordingRecoveryTabIdentity {
  tabId: number;
  documentId?: string;
}

export interface RecordingRecoveryCheckpoint {
  id: typeof ACTIVE_CHECKPOINT_KEY;
  version: typeof RECORDING_RECOVERY_VERSION;
  revision: number;
  sessionId: string;
  status: "recording" | "paused" | "stopping";
  originTabId: number | null;
  activeTabs: RecordingRecoveryTabIdentity[];
  stoppedTabs: number[];
  flow: Flow;
  recordingStartedAtMs: number;
  rateWindowStartedAtMs: number;
  rateWindowStepCount: number;
  stopRetryCount: number;
  limitReached: string | null;
  ingest: RecordingRecoveryIngestState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  nextAlarmAt: number;
}

interface RecordingRecoveryLease {
  version: typeof RECORDING_RECOVERY_VERSION;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
}

export interface RecordingRecoveryStore {
  load(): Promise<unknown | null>;
  save(checkpoint: RecordingRecoveryCheckpoint): Promise<void>;
  clear(expectedSessionId?: string): Promise<void>;
}

let storeMutationQueue: Promise<void> = Promise.resolve();

function enqueueStoreMutation<T>(operation: () => Promise<T>): Promise<T> {
  const queued = storeMutationQueue.catch(() => {}).then(operation);
  storeMutationQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      reject(
        new Error(
          `recording recovery database open failed: ${request.error?.message}`,
        ),
      );
    };
    request.onblocked = () => {
      reject(new Error("recording recovery database open was blocked"));
    };
  });
}

async function runTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => {
        reject(
          new Error(
            `recording recovery request failed: ${request.error?.message}`,
          ),
        );
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => {
        reject(
          new Error(
            `recording recovery transaction failed: ${transaction.error?.message}`,
          ),
        );
      };
      transaction.onabort = () => {
        reject(
          new Error(
            `recording recovery transaction aborted: ${transaction.error?.message}`,
          ),
        );
      };
    });
  } finally {
    db.close();
  }
}

async function readCheckpoint(): Promise<unknown | null> {
  const value = await runTransaction<unknown>("readonly", (store) =>
    store.get(ACTIVE_CHECKPOINT_KEY),
  );
  return value ?? null;
}

async function writeCheckpoint(
  checkpoint: RecordingRecoveryCheckpoint,
): Promise<void> {
  await runTransaction<IDBValidKey>("readwrite", (store) =>
    store.put(checkpoint),
  );
}

async function deleteCheckpoint(): Promise<void> {
  await runTransaction<undefined>(
    "readwrite",
    (store) => store.delete(ACTIVE_CHECKPOINT_KEY) as IDBRequest<undefined>,
  );
}

function isLease(value: unknown): value is RecordingRecoveryLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lease = value as Partial<RecordingRecoveryLease>;
  return (
    lease.version === RECORDING_RECOVERY_VERSION &&
    typeof lease.sessionId === "string" &&
    lease.sessionId.length > 0 &&
    lease.sessionId.length <= 128 &&
    typeof lease.createdAt === "number" &&
    Number.isFinite(lease.createdAt) &&
    typeof lease.expiresAt === "number" &&
    Number.isFinite(lease.expiresAt)
  );
}

async function clearBestEffort(): Promise<void> {
  await Promise.allSettled([
    deleteCheckpoint(),
    chrome.storage.session.remove(RECORDING_RECOVERY_SESSION_KEY),
    Promise.resolve(chrome.alarms.clear(RECORDING_RECOVERY_ALARM)),
  ]);
}

async function clearOrThrow(context: string): Promise<never> {
  const results = await Promise.allSettled([
    deleteCheckpoint(),
    chrome.storage.session.remove(RECORDING_RECOVERY_SESSION_KEY),
    Promise.resolve(chrome.alarms.clear(RECORDING_RECOVERY_ALARM)),
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  throw new Error(
    failure
      ? `${context}; cleanup failed: ${String(
          (failure.reason as Error)?.message || failure.reason,
        )}`
      : context,
  );
}

export const browserRecordingRecoveryStore: RecordingRecoveryStore = {
  async load(): Promise<unknown | null> {
    return enqueueStoreMutation(async () => {
      const stored =
        (await chrome.storage.session.get(RECORDING_RECOVERY_SESSION_KEY)) ??
        {};
      const lease = stored[RECORDING_RECOVERY_SESSION_KEY];
      const hasLease = Object.prototype.hasOwnProperty.call(
        stored,
        RECORDING_RECOVERY_SESSION_KEY,
      );

      // IndexedDB survives a browser restart, while storage.session deliberately
      // does not. The small lease prevents an abandoned private draft from being
      // resumed in a later browser session.
      if (!hasLease) {
        await clearBestEffort();
        return null;
      }
      if (!isLease(lease)) {
        return clearOrThrow("recording recovery lease is malformed");
      }

      const checkpoint = await readCheckpoint();
      if (
        !checkpoint ||
        typeof checkpoint !== "object" ||
        (checkpoint as { sessionId?: unknown }).sessionId !== lease.sessionId
      ) {
        return clearOrThrow(
          "recording recovery checkpoint does not match its lease",
        );
      }
      return checkpoint;
    });
  },

  async save(checkpoint): Promise<void> {
    return enqueueStoreMutation(async () => {
      // Create and await the wake-up before publishing either durable surface.
      // A near-deadline checkpoint is clamped into the future instead of being
      // written without a wake-up guarantee.
      await Promise.resolve(
        chrome.alarms.create(RECORDING_RECOVERY_ALARM, {
          when: Math.max(Date.now() + 1_000, checkpoint.nextAlarmAt),
        }),
      );

      await writeCheckpoint(checkpoint);
      await chrome.storage.session.set({
        [RECORDING_RECOVERY_SESSION_KEY]: {
          version: RECORDING_RECOVERY_VERSION,
          sessionId: checkpoint.sessionId,
          createdAt: checkpoint.createdAt,
          expiresAt: checkpoint.expiresAt,
        } satisfies RecordingRecoveryLease,
      });
    });
  },

  async clear(expectedSessionId?: string): Promise<void> {
    return enqueueStoreMutation(async () => {
      if (expectedSessionId) {
        const stored =
          (await chrome.storage.session.get(RECORDING_RECOVERY_SESSION_KEY)) ??
          {};
        const lease = stored[RECORDING_RECOVERY_SESSION_KEY];
        if (isLease(lease) && lease.sessionId !== expectedSessionId) return;
      }

      const results = await Promise.allSettled([
        deleteCheckpoint(),
        chrome.storage.session.remove(RECORDING_RECOVERY_SESSION_KEY),
        Promise.resolve(chrome.alarms.clear(RECORDING_RECOVERY_ALARM)),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) throw failure.reason;
    });
  },
};
