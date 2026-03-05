type MessageSender = chrome.runtime.MessageSender;

export const RECORDER_EVENT_PROTOCOL_VERSION = 1;

export interface RecorderEventSource {
  tabId: number;
  frameId: number;
}

export interface RecorderEventMeta {
  version: number;
  sessionId: string;
  eventId: string;
  seq: number;
  sentAt?: number;
  source?: {
    href?: string;
    isTop?: boolean;
  };
}

export type RecorderEventDecision = 'accept' | 'duplicate' | 'stale';

export interface RecorderEventAck {
  seq: number;
  eventId: string;
  highWatermarkSeq: number;
  decision: RecorderEventDecision;
}

export function parseRecorderEventMeta(input: unknown):
  | { ok: true; meta: RecorderEventMeta }
  | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'missing meta object' };
  }

  const meta = input as Record<string, unknown>;
  const version = meta.version;
  const sessionId = meta.sessionId;
  const eventId = meta.eventId;
  const seq = meta.seq;
  const sentAt = meta.sentAt;
  const source = meta.source;

  if (version !== RECORDER_EVENT_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `unsupported protocol version: ${String(version)}`,
    };
  }

  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    return { ok: false, error: 'sessionId is required' };
  }

  if (typeof eventId !== 'string' || eventId.trim().length === 0) {
    return { ok: false, error: 'eventId is required' };
  }

  if (!Number.isInteger(seq) || (seq as number) <= 0) {
    return { ok: false, error: 'seq must be a positive integer' };
  }

  if (sentAt !== undefined && !Number.isFinite(sentAt as number)) {
    return { ok: false, error: 'sentAt must be a finite number' };
  }

  if (source !== undefined) {
    if (!source || typeof source !== 'object') {
      return { ok: false, error: 'source must be an object' };
    }
    const sourceObj = source as Record<string, unknown>;
    if (sourceObj.href !== undefined && typeof sourceObj.href !== 'string') {
      return { ok: false, error: 'source.href must be a string' };
    }
    if (sourceObj.isTop !== undefined && typeof sourceObj.isTop !== 'boolean') {
      return { ok: false, error: 'source.isTop must be a boolean' };
    }
  }

  const seqNum = seq as number;
  const sentAtNum = sentAt as number | undefined;

  return {
    ok: true,
    meta: {
      version,
      sessionId,
      eventId,
      seq: seqNum,
      ...(sentAtNum !== undefined ? { sentAt: sentAtNum } : {}),
      ...(source !== undefined ? { source: source as RecorderEventMeta['source'] } : {}),
    },
  };
}

export function getRecorderEventSource(sender: MessageSender): RecorderEventSource {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  return {
    tabId: typeof tabId === 'number' ? tabId : -1,
    frameId: typeof frameId === 'number' ? frameId : 0,
  };
}

export function getRecorderSourceKey(source: RecorderEventSource): string {
  return `${source.tabId}:${source.frameId}`;
}
