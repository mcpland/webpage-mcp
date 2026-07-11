export type DurableAgentRequestSurface = "quick-panel" | "web-editor";
export type DurableAgentRequestPhase =
  | "reserved"
  | "sent"
  | "streaming"
  | "cancel-pending"
  | "terminal";

export interface DurableAgentRequestResult {
  readonly success: boolean;
  readonly summary?: string;
  readonly error?: string;
}

export interface DurableAgentRequestOwner {
  readonly version: 1;
  readonly surface: DurableAgentRequestSurface;
  readonly requestId: string;
  readonly sessionId: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId: string;
  readonly createdAt: number;
  readonly deadlineAt: number;
  readonly phase: DurableAgentRequestPhase;
  readonly status: string;
  readonly message?: string;
  readonly result?: DurableAgentRequestResult;
}

export const DURABLE_AGENT_REQUEST_STORAGE_KEY = "agent-request-owners-v1";
export const DURABLE_AGENT_REQUEST_ALARM_PREFIX = "agent-request-deadline-v1:";
export const DURABLE_AGENT_REQUEST_MAX_ENTRIES = 64;

const MAX_IDENTIFIER_BYTES = 256;
const MAX_DOCUMENT_ID_BYTES = 512;
const MAX_STATUS_BYTES = 64;
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_RESULT_BYTES = 4 * 1024;
const MAX_DEADLINE_SPAN_MS = 24 * 60 * 60 * 1000;

type DurableAgentRequestLedger = Record<string, DurableAgentRequestOwner>;

let mutationQueue: Promise<void> = Promise.resolve();
let cachedLedger: DurableAgentRequestLedger | null = null;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBoundedString(
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maxBytes &&
    utf8Length(value) <= maxBytes
  );
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeResult(
  value: unknown,
): DurableAgentRequestResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const result = value as Record<string, unknown>;
  if (typeof result.success !== "boolean") return undefined;
  const summary = isBoundedString(result.summary, MAX_RESULT_BYTES, true)
    ? result.summary
    : undefined;
  const error = isBoundedString(result.error, MAX_RESULT_BYTES, true)
    ? result.error
    : undefined;
  return {
    success: result.success,
    ...(summary !== undefined ? { summary } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function normalizeOwner(value: unknown): DurableAgentRequestOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const owner = value as Record<string, unknown>;
  if (owner.version !== 1) return null;
  if (owner.surface !== "quick-panel" && owner.surface !== "web-editor")
    return null;
  if (!isBoundedString(owner.requestId, MAX_IDENTIFIER_BYTES)) return null;
  if (!isBoundedString(owner.sessionId, MAX_IDENTIFIER_BYTES)) return null;
  if (!Number.isSafeInteger(owner.tabId) || (owner.tabId as number) < 0)
    return null;
  if (!Number.isSafeInteger(owner.frameId) || (owner.frameId as number) < 0)
    return null;
  if (!isBoundedString(owner.documentId, MAX_DOCUMENT_ID_BYTES, true))
    return null;
  if (!isSafeTimestamp(owner.createdAt) || !isSafeTimestamp(owner.deadlineAt))
    return null;
  if (
    owner.deadlineAt < owner.createdAt ||
    owner.deadlineAt - owner.createdAt > MAX_DEADLINE_SPAN_MS
  ) {
    return null;
  }
  if (
    owner.phase !== "reserved" &&
    owner.phase !== "sent" &&
    owner.phase !== "streaming" &&
    owner.phase !== "cancel-pending" &&
    owner.phase !== "terminal"
  ) {
    return null;
  }
  if (!isBoundedString(owner.status, MAX_STATUS_BYTES)) return null;
  const message = isBoundedString(owner.message, MAX_MESSAGE_BYTES, true)
    ? owner.message
    : undefined;
  const result = normalizeResult(owner.result);

  return {
    version: 1,
    surface: owner.surface,
    requestId: owner.requestId,
    sessionId: owner.sessionId,
    tabId: owner.tabId as number,
    frameId: owner.frameId as number,
    documentId: owner.documentId,
    createdAt: owner.createdAt,
    deadlineAt: owner.deadlineAt,
    phase: owner.phase,
    status: owner.status,
    ...(message !== undefined ? { message } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}

function ownerKey(
  surface: DurableAgentRequestSurface,
  requestId: string,
): string {
  return `${surface}:${requestId}`;
}

function requireSessionStorage(): typeof chrome.storage.session {
  const storage = chrome.storage?.session;
  if (!storage?.get || !storage?.set || !storage?.remove) {
    throw new Error("chrome.storage.session is unavailable");
  }
  return storage;
}

async function readLedger(): Promise<DurableAgentRequestLedger> {
  if (cachedLedger) return { ...cachedLedger };

  const storage = requireSessionStorage();
  const stored = await storage.get(DURABLE_AGENT_REQUEST_STORAGE_KEY);
  const raw = stored?.[DURABLE_AGENT_REQUEST_STORAGE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    cachedLedger = {};
    return {};
  }

  const normalized: DurableAgentRequestLedger = {};
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([, value]) => normalizeOwner(value))
    .filter((value): value is DurableAgentRequestOwner => value !== null)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-DURABLE_AGENT_REQUEST_MAX_ENTRIES);
  for (const owner of entries) {
    normalized[ownerKey(owner.surface, owner.requestId)] = owner;
  }
  cachedLedger = normalized;
  return { ...normalized };
}

async function writeLedger(ledger: DurableAgentRequestLedger): Promise<void> {
  const storage = requireSessionStorage();
  if (Object.keys(ledger).length === 0) {
    await storage.remove(DURABLE_AGENT_REQUEST_STORAGE_KEY);
    cachedLedger = {};
    return;
  }
  await storage.set({ [DURABLE_AGENT_REQUEST_STORAGE_KEY]: ledger });
  cachedLedger = { ...ledger };
}

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationQueue.catch(() => undefined).then(operation);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function durableAgentRequestAlarmName(
  surface: DurableAgentRequestSurface,
  requestId: string,
): string {
  return `${DURABLE_AGENT_REQUEST_ALARM_PREFIX}${surface}:${encodeURIComponent(requestId)}`;
}

export function requestIdFromDurableAgentAlarm(
  alarmName: string,
  surface: DurableAgentRequestSurface,
): string | null {
  const prefix = `${DURABLE_AGENT_REQUEST_ALARM_PREFIX}${surface}:`;
  if (!alarmName.startsWith(prefix)) return null;
  try {
    const requestId = decodeURIComponent(alarmName.slice(prefix.length));
    return isBoundedString(requestId, MAX_IDENTIFIER_BYTES) ? requestId : null;
  } catch {
    return null;
  }
}

async function createDeadlineAlarm(
  owner: DurableAgentRequestOwner,
): Promise<void> {
  if (!chrome.alarms?.create) {
    throw new Error("chrome.alarms is unavailable");
  }
  await Promise.resolve(
    chrome.alarms.create(
      durableAgentRequestAlarmName(owner.surface, owner.requestId),
      {
        when: owner.deadlineAt,
      },
    ),
  );
}

function phaseRank(phase: DurableAgentRequestPhase): number {
  switch (phase) {
    case "reserved":
      return 0;
    case "sent":
      return 1;
    case "streaming":
      return 2;
    case "cancel-pending":
      return 3;
    case "terminal":
      return 4;
  }
}

function hasSameOwnerIdentity(
  previous: DurableAgentRequestOwner,
  next: DurableAgentRequestOwner,
): boolean {
  return (
    previous.version === next.version &&
    previous.surface === next.surface &&
    previous.requestId === next.requestId &&
    previous.sessionId === next.sessionId &&
    previous.tabId === next.tabId &&
    previous.frameId === next.frameId &&
    previous.documentId === next.documentId &&
    previous.createdAt === next.createdAt
  );
}

async function clearDeadlineAlarm(
  surface: DurableAgentRequestSurface,
  requestId: string,
): Promise<void> {
  if (!chrome.alarms?.clear) return;
  await Promise.resolve(
    chrome.alarms.clear(durableAgentRequestAlarmName(surface, requestId)),
  ).catch(() => false);
}

export async function reserveDurableAgentRequestOwner(
  value: DurableAgentRequestOwner,
): Promise<void> {
  const owner = normalizeOwner(value);
  if (!owner) throw new Error("Invalid durable Agent request owner");

  await enqueueMutation(async () => {
    const ledger = await readLedger();
    const key = ownerKey(owner.surface, owner.requestId);
    if (ledger[key])
      throw new Error("Durable Agent request owner already exists");
    if (Object.keys(ledger).length >= DURABLE_AGENT_REQUEST_MAX_ENTRIES) {
      throw new Error("Durable Agent request owner limit reached");
    }
    if (
      owner.surface === "quick-panel" &&
      Object.values(ledger).some(
        (entry) =>
          entry.surface === owner.surface &&
          entry.tabId === owner.tabId &&
          entry.frameId === owner.frameId &&
          entry.documentId === owner.documentId &&
          entry.phase !== "terminal",
      )
    ) {
      throw new Error("Quick Panel document already owns an Agent request");
    }
    if (
      owner.surface === "web-editor" &&
      Object.values(ledger).some(
        (entry) =>
          entry.surface === owner.surface &&
          entry.sessionId === owner.sessionId &&
          entry.phase !== "terminal",
      )
    ) {
      throw new Error("Web Editor session already owns an Agent request");
    }

    // Alarm-first ordering means a worker crash can leave only a harmless
    // alarm without an owner, never an owner without a wake-up deadline.
    await createDeadlineAlarm(owner);
    try {
      ledger[key] = owner;
      await writeLedger(ledger);
    } catch (error) {
      await clearDeadlineAlarm(owner.surface, owner.requestId);
      throw error;
    }
  });
}

export async function transitionDurableAgentRequestOwner(
  value: DurableAgentRequestOwner,
): Promise<void> {
  const owner = normalizeOwner(value);
  if (!owner) throw new Error("Invalid durable Agent request owner");

  await enqueueMutation(async () => {
    const ledger = await readLedger();
    const key = ownerKey(owner.surface, owner.requestId);
    const previous = ledger[key];
    if (!previous)
      throw new Error("Durable Agent request owner no longer exists");
    if (!hasSameOwnerIdentity(previous, owner)) {
      throw new Error("Durable Agent request owner identity changed");
    }
    if (owner.deadlineAt !== previous.deadlineAt) {
      throw new Error(
        "Durable Agent request deadline transition requires rescheduling",
      );
    }
    if (previous.phase === "terminal") return;
    if (phaseRank(owner.phase) < phaseRank(previous.phase)) {
      throw new Error("Durable Agent request phase cannot move backwards");
    }
    ledger[key] = owner;
    await writeLedger(ledger);
  });
}

export async function rescheduleDurableAgentRequestOwner(
  value: DurableAgentRequestOwner,
): Promise<void> {
  const owner = normalizeOwner(value);
  if (!owner) throw new Error("Invalid durable Agent request owner");

  await enqueueMutation(async () => {
    const ledger = await readLedger();
    const key = ownerKey(owner.surface, owner.requestId);
    const previous = ledger[key];
    if (!previous)
      throw new Error("Durable Agent request owner no longer exists");
    if (!hasSameOwnerIdentity(previous, owner)) {
      throw new Error("Durable Agent request owner identity changed");
    }
    if (previous.phase === "terminal") return;
    if (phaseRank(owner.phase) < phaseRank(previous.phase)) {
      throw new Error("Durable Agent request phase cannot move backwards");
    }

    await createDeadlineAlarm(owner);
    try {
      ledger[key] = owner;
      await writeLedger(ledger);
    } catch (error) {
      await createDeadlineAlarm(previous).catch(() => undefined);
      throw error;
    }
  });
}

export async function rearmDurableAgentRequestDeadline(
  owner: DurableAgentRequestOwner,
): Promise<void> {
  const normalized = normalizeOwner(owner);
  if (!normalized) throw new Error("Invalid durable Agent request owner");
  await enqueueMutation(async () => {
    const ledger = await readLedger();
    const current = ledger[ownerKey(normalized.surface, normalized.requestId)];
    if (!current || !hasSameOwnerIdentity(current, normalized)) {
      throw new Error("Durable Agent request owner no longer exists");
    }
    await createDeadlineAlarm(current);
  });
}

export async function getDurableAgentRequestOwner(
  surface: DurableAgentRequestSurface,
  requestId: string,
): Promise<DurableAgentRequestOwner | undefined> {
  await mutationQueue.catch(() => undefined);
  const ledger = await readLedger();
  return ledger[ownerKey(surface, requestId)];
}

export async function listDurableAgentRequestOwners(
  surface: DurableAgentRequestSurface,
): Promise<DurableAgentRequestOwner[]> {
  await mutationQueue.catch(() => undefined);
  const ledger = await readLedger();
  return Object.values(ledger)
    .filter((owner) => owner.surface === surface)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeDurableAgentRequestOwner(
  surface: DurableAgentRequestSurface,
  requestId: string,
): Promise<void> {
  await enqueueMutation(async () => {
    const ledger = await readLedger();
    delete ledger[ownerKey(surface, requestId)];
    await writeLedger(ledger);
    await clearDeadlineAlarm(surface, requestId);
  });
}
