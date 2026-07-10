type MessageSender = chrome.runtime.MessageSender;

export const RECORDER_EVENT_PROTOCOL_VERSION = 1;

export interface RecorderEventSource {
  tabId: number;
  frameId: number;
  documentId: string;
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
    documentId?: string;
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
    if (
      sourceObj.documentId !== undefined &&
      (typeof sourceObj.documentId !== 'string' ||
        sourceObj.documentId.length === 0 ||
        sourceObj.documentId.length > 128)
    ) {
      return { ok: false, error: 'source.documentId must be a non-empty bounded string' };
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

export function getRecorderEventSource(
  sender: MessageSender,
  meta?: RecorderEventMeta,
): RecorderEventSource {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  const senderDocumentId = sender?.documentId;
  const metaDocumentId = meta?.source?.documentId;
  return {
    tabId: typeof tabId === 'number' ? tabId : -1,
    frameId: typeof frameId === 'number' ? frameId : 0,
    documentId:
      typeof senderDocumentId === 'string' &&
      senderDocumentId.length > 0 &&
      senderDocumentId.length <= 128
        ? senderDocumentId
        : typeof metaDocumentId === 'string' &&
            metaDocumentId.length > 0 &&
            metaDocumentId.length <= 128
          ? metaDocumentId
          : 'legacy-document',
  };
}

export function getRecorderSourceKey(source: RecorderEventSource): string {
  return JSON.stringify([source.tabId, source.frameId, source.documentId]);
}
