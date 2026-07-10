import type { AgentMessage } from '../types';
import {
  AGENT_MESSAGE_CONTENT_MAX_BYTES,
  AGENT_MESSAGE_METADATA_MAX_JSON_BYTES,
  AGENT_STORED_MESSAGE_MAX_JSON_BYTES,
} from 'webpage-mcp-shared';

/** Coalesce cumulative UI snapshots instead of serializing one after every token. */
export const STREAM_SNAPSHOT_INTERVAL_MS = 50;

/** Hard in-memory limits for one assistant turn. */
export const STREAM_ASSISTANT_TEXT_MAX_BYTES = AGENT_MESSAGE_CONTENT_MAX_BYTES;
export const STREAM_THINKING_TEXT_MAX_BYTES = 64 * 1024;

/** Hard limits for tool events and streamed Claude tool input. */
export const STREAM_TOOL_CONTENT_MAX_BYTES = AGENT_MESSAGE_CONTENT_MAX_BYTES;
export const STREAM_TOOL_METADATA_MAX_BYTES = AGENT_MESSAGE_METADATA_MAX_JSON_BYTES;
export const STREAM_PENDING_TOOL_INPUT_MAX_BYTES = 64 * 1024;
export const STREAM_TOOL_FIELD_MAX_BYTES = 16 * 1024;

/** Hard collection limits for long-running turns. */
export const STREAM_DEDUPE_MAX_ENTRIES = 1_024;
export const STREAM_ACTIVE_COMMAND_MAX_ENTRIES = 128;
export const STREAM_PENDING_TOOL_MAX_ENTRIES = 64;

/**
 * Keep engine output below the persisted-message budget. The headroom covers
 * project and database-only fields added after the streamed message is built.
 */
export const STREAM_AGENT_PERSISTENCE_HEADROOM_BYTES = 4 * 1024;
export const STREAM_AGENT_MESSAGE_MAX_JSON_BYTES =
  AGENT_STORED_MESSAGE_MAX_JSON_BYTES - STREAM_AGENT_PERSISTENCE_HEADROOM_BYTES;

const TRUNCATION_MARKER = '\n\n… [truncated]';
const METADATA_SUMMARY_MAX_KEYS = 32;
const METADATA_SUMMARY_STRING_MAX_BYTES = 2 * 1024;
const ACCUMULATOR_MAX_CHUNKS = 128;

export interface StreamTruncationDetail {
  field: string;
  originalBytes: number;
  retainedBytes: number;
}

export interface BoundedTextSnapshot {
  text: string;
  truncated: boolean;
  originalBytes: number;
  retainedBytes: number;
}

export interface AssistantStreamSnapshot {
  content: string;
  truncation: StreamTruncationDetail[];
}

export interface SnapshotScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: SnapshotScheduler = {
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sliceUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0 || value.length === 0) return '';
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maximumBytes) return value;

  // Buffer replaces an incomplete trailing sequence with U+FFFD. Drop that
  // replacement so the returned prefix always consists of complete code points.
  return encoded.subarray(0, maximumBytes).toString('utf8').replace(/\uFFFD$/, '');
}

function safeCodeUnitPrefix(value: string, length: number): string {
  let end = Math.max(0, Math.min(length, value.length));
  if (end > 0) {
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}

function appendTruncationMarker(value: string, maximumBytes: number): string {
  const markerBytes = byteLength(TRUNCATION_MARKER);
  if (maximumBytes <= markerBytes) return sliceUtf8(TRUNCATION_MARKER, maximumBytes);
  return `${sliceUtf8(value, maximumBytes - markerBytes)}${TRUNCATION_MARKER}`;
}

/** UTF-8 byte-bounded, append-efficient accumulator for streamed text. */
export class BoundedTextAccumulator {
  private chunks: string[] = [];
  private keptBytes = 0;
  private totalBytes = 0;
  private didTruncate = false;

  public constructor(public readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= byteLength(TRUNCATION_MARKER)) {
      throw new RangeError('maximumBytes must be a safe integer larger than the truncation marker');
    }
  }

  public append(value: string): boolean {
    if (!value) return false;
    const incomingBytes = byteLength(value);
    this.totalBytes += incomingBytes;

    const available = Math.max(0, this.maximumBytes - this.keptBytes);
    if (available === 0) {
      const changed = !this.didTruncate;
      this.didTruncate = true;
      return changed;
    }

    const retained = incomingBytes <= available ? value : sliceUtf8(value, available);
    const retainedBytes = byteLength(retained);
    if (retained) {
      this.chunks.push(retained);
      this.keptBytes += retainedBytes;
      this.compactChunks();
    }
    if (retainedBytes < incomingBytes) this.didTruncate = true;
    return retainedBytes > 0 || retainedBytes < incomingBytes;
  }

  public replace(value: string): void {
    this.clear();
    this.append(value);
  }

  public clear(): void {
    this.chunks = [];
    this.keptBytes = 0;
    this.totalBytes = 0;
    this.didTruncate = false;
  }

  public hasContent(): boolean {
    return this.keptBytes > 0;
  }

  public endsWith(value: string): boolean {
    if (!value || byteLength(value) > this.keptBytes) return false;
    return this.joinChunks().endsWith(value);
  }

  public snapshot(): BoundedTextSnapshot {
    const raw = this.joinChunks();
    const truncated = this.didTruncate || this.totalBytes > this.maximumBytes;
    const text = truncated ? appendTruncationMarker(raw, this.maximumBytes) : raw;
    return {
      text,
      truncated,
      originalBytes: this.totalBytes,
      retainedBytes: byteLength(text),
    };
  }

  private compactChunks(): void {
    if (this.chunks.length <= ACCUMULATOR_MAX_CHUNKS) return;
    this.chunks = [this.chunks.join('')];
  }

  private joinChunks(): string {
    if (this.chunks.length === 0) return '';
    if (this.chunks.length === 1) return this.chunks[0];
    const joined = this.chunks.join('');
    this.chunks = [joined];
    return joined;
  }
}

/** Insertion-ordered bounded set; oldest keys are evicted first. */
export class BoundedSet<T> {
  private readonly values = new Set<T>();

  public constructor(public readonly maximumEntries: number) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
      throw new RangeError('maximumEntries must be a positive safe integer');
    }
  }

  public has(value: T): boolean {
    return this.values.has(value);
  }

  public add(value: T): void {
    if (this.values.has(value)) return;
    this.values.add(value);
    if (this.values.size <= this.maximumEntries) return;
    const oldest = this.values.values().next().value as T | undefined;
    if (oldest !== undefined) this.values.delete(oldest);
  }

  public get size(): number {
    return this.values.size;
  }
}

/** Insertion-ordered bounded map; setting a new key evicts the oldest entry. */
export class BoundedMap<K, V> {
  private readonly values = new Map<K, V>();

  public constructor(public readonly maximumEntries: number) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0) {
      throw new RangeError('maximumEntries must be a positive safe integer');
    }
  }

  public set(key: K, value: V): { key: K; value: V } | undefined {
    if (this.values.has(key)) this.values.delete(key);
    this.values.set(key, value);
    if (this.values.size <= this.maximumEntries) return undefined;
    const oldest = this.values.entries().next().value as [K, V] | undefined;
    if (!oldest) return undefined;
    this.values.delete(oldest[0]);
    return { key: oldest[0], value: oldest[1] };
  }

  public get(key: K): V | undefined {
    return this.values.get(key);
  }

  public has(key: K): boolean {
    return this.values.has(key);
  }

  public delete(key: K): boolean {
    return this.values.delete(key);
  }

  public clear(): void {
    this.values.clear();
  }

  public get size(): number {
    return this.values.size;
  }
}

/**
 * Shared assistant/thinking stream used by both engines. It keeps the UI's
 * cumulative snapshot contract while coalescing token deltas and synchronously
 * flushing the final state.
 */
export class BoundedAssistantStream {
  private readonly assistant: BoundedTextAccumulator;
  private readonly thinking: BoundedTextAccumulator;
  private timer: unknown | null = null;
  private dirty = false;

  public constructor(
    private readonly emit: (snapshot: AssistantStreamSnapshot, isFinal: boolean) => void,
    private readonly options: {
      intervalMs?: number;
      scheduler?: SnapshotScheduler;
      assistantMaximumBytes?: number;
      thinkingMaximumBytes?: number;
    } = {},
  ) {
    this.assistant = new BoundedTextAccumulator(
      options.assistantMaximumBytes ?? STREAM_ASSISTANT_TEXT_MAX_BYTES,
    );
    this.thinking = new BoundedTextAccumulator(
      options.thinkingMaximumBytes ?? STREAM_THINKING_TEXT_MAX_BYTES,
    );
  }

  public appendAssistant(value: string): void {
    if (this.assistant.append(value)) this.queueSnapshot();
  }

  public replaceAssistant(value: string): void {
    this.assistant.replace(value);
    this.queueSnapshot();
  }

  public appendThinking(value: string): void {
    if (this.thinking.append(value)) this.queueSnapshot();
  }

  public replaceThinking(value: string): void {
    this.thinking.replace(value);
    this.queueSnapshot();
  }

  public thinkingEndsWith(value: string): boolean {
    return this.thinking.endsWith(value);
  }

  public hasContent(): boolean {
    return this.assistant.hasContent() || this.thinking.hasContent();
  }

  public flushFinal(): void {
    this.clearTimer();
    this.dirty = false;
    this.emit(this.buildSnapshot(), true);
  }

  public reset(): void {
    this.cancel();
    this.assistant.clear();
    this.thinking.clear();
  }

  public cancel(): void {
    this.clearTimer();
    this.dirty = false;
  }

  private queueSnapshot(): void {
    this.dirty = true;
    if (this.timer !== null) return;
    const scheduler = this.options.scheduler ?? defaultScheduler;
    this.timer = scheduler.setTimeout(() => {
      this.timer = null;
      if (!this.dirty) return;
      this.dirty = false;
      this.emit(this.buildSnapshot(), false);
    }, this.options.intervalMs ?? STREAM_SNAPSHOT_INTERVAL_MS);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    (this.options.scheduler ?? defaultScheduler).clearTimeout(this.timer);
    this.timer = null;
  }

  private buildSnapshot(): AssistantStreamSnapshot {
    const assistant = this.assistant.snapshot();
    const thinking = this.thinking.snapshot();
    const parts: string[] = [];
    if (thinking.text.trim()) parts.push(`<thinking>${thinking.text.trim()}</thinking>`);
    if (assistant.text.trim()) parts.push(assistant.text.trim());

    const truncation: StreamTruncationDetail[] = [];
    if (assistant.truncated) {
      truncation.push({
        field: 'assistant',
        originalBytes: assistant.originalBytes,
        retainedBytes: assistant.retainedBytes,
      });
    }
    if (thinking.truncated) {
      truncation.push({
        field: 'thinking',
        originalBytes: thinking.originalBytes,
        retainedBytes: thinking.retainedBytes,
      });
    }

    return { content: parts.join('\n\n').trim(), truncation };
  }
}

function serializedBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : byteLength(serialized);
  } catch {
    return null;
  }
}

export function boundStreamText(value: string, maximumBytes: number): BoundedTextSnapshot {
  const accumulator = new BoundedTextAccumulator(maximumBytes);
  accumulator.append(value);
  return accumulator.snapshot();
}

function summarizeMetadataValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    return boundStreamText(value, METADATA_SUMMARY_STRING_MAX_BYTES).text;
  }
  if (Array.isArray(value)) return `[truncated array with ${value.length} items]`;
  if (value && typeof value === 'object') return '[truncated object]';
  return String(value);
}

function boundMetadata(metadata: Record<string, unknown> | undefined): {
  metadata: Record<string, unknown> | undefined;
  truncation?: StreamTruncationDetail;
} {
  if (!metadata) return { metadata: undefined };
  const originalBytes = serializedBytes(metadata);
  if (originalBytes !== null && originalBytes <= STREAM_TOOL_METADATA_MAX_BYTES) {
    return { metadata };
  }

  const summary = Object.create(null) as Record<string, unknown>;
  summary.truncated = true;
  let entries: [string, unknown][] = [];
  try {
    entries = Object.entries(metadata).slice(0, METADATA_SUMMARY_MAX_KEYS);
  } catch {
    // A hostile Proxy can throw while enumerating. The bounded marker below is
    // still safe to stream and persist.
  }
  for (const [key, value] of entries) {
    if (key === 'truncated') continue;
    let summarizedValue: unknown;
    if (key === 'truncation' && value && typeof value === 'object') {
      const truncationBytes = serializedBytes(value);
      summarizedValue =
        truncationBytes !== null && truncationBytes <= METADATA_SUMMARY_STRING_MAX_BYTES
          ? value
          : '[truncated object]';
    } else {
      summarizedValue = summarizeMetadataValue(value);
    }

    // String byte limits alone are insufficient because JSON escaping can
    // expand control characters six-fold and property names are untrusted.
    const candidate = { ...summary, [key]: summarizedValue };
    const candidateBytes = serializedBytes(candidate);
    if (candidateBytes !== null && candidateBytes <= STREAM_TOOL_METADATA_MAX_BYTES) {
      summary[key] = summarizedValue;
    }
  }

  const retainedBytes = serializedBytes(summary) ?? 0;
  return {
    metadata: summary,
    truncation: {
      field: 'metadata',
      originalBytes: originalBytes ?? -1,
      retainedBytes,
    },
  };
}

function withTruncationMetadata(
  metadata: Record<string, unknown> | undefined,
  truncation: StreamTruncationDetail[],
): Record<string, unknown> | undefined {
  if (truncation.length === 0) return metadata;
  const existing = metadata?.truncation;
  const existingEntries = Array.isArray(existing) ? existing : [];
  return {
    ...(metadata ?? {}),
    truncated: true,
    truncation: [...existingEntries, ...truncation],
  };
}

function fitMessageContentToBudget(message: AgentMessage): { message: AgentMessage; truncated: boolean } {
  const initialBytes = serializedBytes(message);
  if (initialBytes !== null && initialBytes <= STREAM_AGENT_MESSAGE_MAX_JSON_BYTES) {
    return { message, truncated: false };
  }

  let low = 0;
  let high = message.content.length;
  let best = TRUNCATION_MARKER.trim();
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateContent = `${safeCodeUnitPrefix(message.content, middle)}${TRUNCATION_MARKER}`;
    const candidate = { ...message, content: candidateContent };
    const size = serializedBytes(candidate);
    if (size !== null && size <= STREAM_AGENT_MESSAGE_MAX_JSON_BYTES) {
      best = candidateContent;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return { message: { ...message, content: best }, truncated: true };
}

/**
 * Bound every AgentMessage before it reaches a native-messaging subscription.
 * Existing fields remain unchanged unless their payload exceeds an explicit
 * budget, in which case metadata and a visible content marker report truncation.
 */
export function createBoundedAgentMessage(
  message: AgentMessage,
  options: {
    contentMaximumBytes?: number;
    truncation?: StreamTruncationDetail[];
  } = {},
): AgentMessage {
  const content = boundStreamText(
    message.content,
    options.contentMaximumBytes ?? STREAM_TOOL_CONTENT_MAX_BYTES,
  );
  const truncation = [...(options.truncation ?? [])];
  if (content.truncated) {
    truncation.push({
      field: 'content',
      originalBytes: content.originalBytes,
      retainedBytes: content.retainedBytes,
    });
  }

  const firstMetadata = boundMetadata(withTruncationMetadata(message.metadata, truncation));
  if (firstMetadata.truncation) truncation.push(firstMetadata.truncation);
  // Adding truncation diagnostics can itself cross the metadata budget. Bound
  // once more after all diagnostics have been attached.
  const finalInitialMetadata = boundMetadata(
    withTruncationMetadata(firstMetadata.metadata, truncation),
  );

  let candidate: AgentMessage = {
    ...message,
    content: content.text,
    metadata: finalInitialMetadata.metadata,
  };
  let fitted = fitMessageContentToBudget(candidate);

  if (fitted.truncated) {
    const messageTruncation: StreamTruncationDetail = {
      field: 'message',
      originalBytes: serializedBytes(candidate) ?? -1,
      retainedBytes: serializedBytes(fitted.message) ?? 0,
    };
    const finalMetadata = boundMetadata(
      withTruncationMetadata(fitted.message.metadata, [messageTruncation]),
    );
    candidate = { ...fitted.message, metadata: finalMetadata.metadata };
    fitted = fitMessageContentToBudget(candidate);
  }

  return fitted.message;
}
