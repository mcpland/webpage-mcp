import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../types';
import {
  BoundedAssistantStream,
  BoundedMap,
  BoundedSet,
  BoundedTextAccumulator,
  STREAM_AGENT_MESSAGE_MAX_JSON_BYTES,
  STREAM_AGENT_PERSISTENCE_HEADROOM_BYTES,
  STREAM_DEDUPE_MAX_ENTRIES,
  STREAM_PENDING_TOOL_INPUT_MAX_BYTES,
  STREAM_SNAPSHOT_INTERVAL_MS,
  createBoundedAgentMessage,
  type AssistantStreamSnapshot,
  type SnapshotScheduler,
} from './stream-output';
import {
  AGENT_CLI_SOURCE_MAX_BYTES,
  AGENT_CREATED_AT_MAX_BYTES,
  AGENT_IDENTIFIER_MAX_BYTES,
  AGENT_MESSAGE_METADATA_MAX_JSON_BYTES,
  AGENT_STORED_MESSAGE_MAX_JSON_BYTES,
} from 'webpage-mcp-shared';
import { validateStoredMessagePayload } from '../payload-limits';

class ManualScheduler implements SnapshotScheduler {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();
  public readonly delays: number[] = [];

  public setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    this.delays.push(delayMs);
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  public runAll(): void {
    while (this.callbacks.size > 0) {
      const pending = Array.from(this.callbacks.entries());
      this.callbacks.clear();
      for (const [, callback] of pending) callback();
    }
  }

  public get pendingCount(): number {
    return this.callbacks.size;
  }
}

function createMessage(content: string, metadata?: Record<string, unknown>): AgentMessage {
  return {
    id: 'message-1',
    sessionId: 'session-1',
    role: 'assistant',
    content,
    messageType: 'chat',
    cliSource: 'test',
    requestId: 'request-1',
    isStreaming: true,
    isFinal: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata,
  };
}

describe('BoundedAssistantStream', () => {
  it('coalesces thousands of deltas and synchronously flushes the final snapshot', () => {
    const scheduler = new ManualScheduler();
    const emitted: Array<{ snapshot: AssistantStreamSnapshot; isFinal: boolean }> = [];
    const stream = new BoundedAssistantStream(
      (snapshot, isFinal) => emitted.push({ snapshot, isFinal }),
      { scheduler },
    );

    for (let index = 0; index < 5_000; index++) stream.appendAssistant('a');

    expect(emitted).toHaveLength(0);
    expect(scheduler.pendingCount).toBe(1);
    expect(scheduler.delays).toEqual([STREAM_SNAPSHOT_INTERVAL_MS]);

    scheduler.runAll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].isFinal).toBe(false);
    expect(emitted[0].snapshot.content).toHaveLength(5_000);

    for (let index = 0; index < 5_000; index++) stream.appendThinking('t');
    expect(scheduler.pendingCount).toBe(1);

    stream.flushFinal();
    expect(scheduler.pendingCount).toBe(0);
    expect(emitted).toHaveLength(2);
    expect(emitted[1].isFinal).toBe(true);
    expect(emitted[1].snapshot.content).toContain('<thinking>');

    scheduler.runAll();
    expect(emitted).toHaveLength(2);
  });

  it('keeps every coalesced and final message inside the serialized transport budget', () => {
    const scheduler = new ManualScheduler();
    const emitted: AgentMessage[] = [];
    const stream = new BoundedAssistantStream(
      (snapshot, isFinal) => {
        emitted.push(
          createBoundedAgentMessage(
            {
              ...createMessage(snapshot.content),
              isStreaming: !isFinal,
              isFinal,
            },
            { contentMaximumBytes: 256 * 1024, truncation: snapshot.truncation },
          ),
        );
      },
      { scheduler },
    );

    for (let index = 0; index < 10_000; index++) {
      // Control characters expand six-fold in JSON and exercise the serialized,
      // rather than merely in-memory, byte budget.
      stream.appendAssistant(`\u0000${'x'.repeat(99)}`);
      if ((index + 1) % 250 === 0) scheduler.runAll();
    }
    stream.flushFinal();

    expect(emitted.length).toBeLessThanOrEqual(41);
    expect(emitted.at(-1)?.isFinal).toBe(true);
    expect(emitted.at(-1)?.content).toContain('[truncated]');
    expect(emitted.at(-1)?.metadata?.truncated).toBe(true);
    for (const message of emitted) {
      expect(Buffer.byteLength(JSON.stringify(message), 'utf8')).toBeLessThanOrEqual(
        STREAM_AGENT_MESSAGE_MAX_JSON_BYTES,
      );
    }
  });

  it('cancels its pending timer without emitting after reset', () => {
    const scheduler = new ManualScheduler();
    const emitted: AssistantStreamSnapshot[] = [];
    const stream = new BoundedAssistantStream((snapshot) => emitted.push(snapshot), { scheduler });

    stream.appendAssistant('discard me');
    stream.reset();
    scheduler.runAll();

    expect(scheduler.pendingCount).toBe(0);
    expect(emitted).toEqual([]);
    expect(stream.hasContent()).toBe(false);
  });
});

describe('stream output bounds', () => {
  it('reserves enough persisted-message headroom for maximum bounded engine output', () => {
    const bounded = createBoundedAgentMessage(
      {
        ...createMessage('\u0000'.repeat(400_000), {
          output: '\u0000'.repeat(100_000),
        }),
        id: 'i'.repeat(AGENT_IDENTIFIER_MAX_BYTES),
        sessionId: 's'.repeat(AGENT_IDENTIFIER_MAX_BYTES),
        requestId: 'r'.repeat(AGENT_IDENTIFIER_MAX_BYTES),
        cliSource: 'c'.repeat(AGENT_CLI_SOURCE_MAX_BYTES),
        createdAt: 'd'.repeat(AGENT_CREATED_AT_MAX_BYTES),
      },
    );

    expect(
      STREAM_AGENT_MESSAGE_MAX_JSON_BYTES + STREAM_AGENT_PERSISTENCE_HEADROOM_BYTES,
    ).toBe(AGENT_STORED_MESSAGE_MAX_JSON_BYTES);
    expect(() =>
      validateStoredMessagePayload({
        id: bounded.id,
        projectId: 'p'.repeat(AGENT_IDENTIFIER_MAX_BYTES),
        sessionId: bounded.sessionId,
        conversationId: 'v'.repeat(AGENT_IDENTIFIER_MAX_BYTES),
        role: bounded.role,
        content: bounded.content,
        messageType: bounded.messageType,
        metadata: bounded.metadata,
        cliSource: bounded.cliSource ?? null,
        requestId: bounded.requestId ?? null,
        createdAt: bounded.createdAt,
      }),
    ).not.toThrow();
  });

  it('keeps summarized metadata inside its JSON budget after escaping hostile fields', () => {
    const metadata = Object.fromEntries([
      ['k'.repeat(AGENT_MESSAGE_METADATA_MAX_JSON_BYTES), 'oversized key'],
      ['__proto__', { polluted: true }],
      ...Array.from({ length: 40 }, (_, index) => [
        `control-${index}`,
        '\u0000'.repeat(4_000),
      ]),
    ]) as Record<string, unknown>;
    const bounded = createBoundedAgentMessage(createMessage('bounded content', metadata));

    expect(Buffer.byteLength(JSON.stringify(bounded.metadata), 'utf8')).toBeLessThanOrEqual(
      AGENT_MESSAGE_METADATA_MAX_JSON_BYTES,
    );
    expect(bounded.metadata?.truncated).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() =>
      validateStoredMessagePayload({
        id: bounded.id,
        projectId: 'project-1',
        sessionId: bounded.sessionId,
        role: bounded.role,
        content: bounded.content,
        messageType: bounded.messageType,
        metadata: bounded.metadata,
        cliSource: bounded.cliSource,
        requestId: bounded.requestId,
        createdAt: bounded.createdAt,
      }),
    ).not.toThrow();
  });

  it('bounds UTF-8 text and reports retained and original bytes', () => {
    const accumulator = new BoundedTextAccumulator(128);
    for (let index = 0; index < 1_000; index++) accumulator.append('🚀');

    const snapshot = accumulator.snapshot();
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.originalBytes).toBe(4_000);
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(snapshot.text, 'utf8')).toBeLessThanOrEqual(128);
    expect(snapshot.text).toContain('[truncated]');
    expect(snapshot.text).not.toContain('\uFFFD');
  });

  it('bounds pending tool JSON before joining thousands of partial deltas', () => {
    const input = new BoundedTextAccumulator(STREAM_PENDING_TOOL_INPUT_MAX_BYTES);
    for (let index = 0; index < 20_000; index++) input.append('{"value":"delta"}');

    const snapshot = input.snapshot();
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(STREAM_PENDING_TOOL_INPUT_MAX_BYTES);
    expect(snapshot.originalBytes).toBeGreaterThan(STREAM_PENDING_TOOL_INPUT_MAX_BYTES);
  });

  it('records upstream truncation without appending sentinel payload bytes', () => {
    const input = new BoundedTextAccumulator(128);
    input.append('{"value":"partial"}');
    input.markTruncated(7);

    const snapshot = input.snapshot();
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.originalBytes).toBe(
      Buffer.byteLength('{"value":"partial"}', 'utf8') + 7,
    );
    expect(snapshot.text).toContain('[truncated]');
    expect(snapshot.text).not.toContain('....');
  });

  it('bounds adversarial content and metadata by actual JSON bytes', () => {
    const circular: Record<string, unknown> = {
      command: '\u0000'.repeat(200_000),
      output: 'y'.repeat(500_000),
    };
    circular.self = circular;

    const bounded = createBoundedAgentMessage(
      createMessage('\u0000'.repeat(400_000), circular),
    );
    const serializedBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8');

    expect(serializedBytes).toBeLessThanOrEqual(STREAM_AGENT_MESSAGE_MAX_JSON_BYTES);
    expect(bounded.content).toContain('[truncated]');
    expect(bounded.metadata?.truncated).toBe(true);
    expect(bounded.metadata?.self).toBe('[truncated object]');
  });

  it('evicts oldest dedupe and active entries at explicit limits', () => {
    const dedupe = new BoundedSet<number>(STREAM_DEDUPE_MAX_ENTRIES);
    for (let index = 0; index < STREAM_DEDUPE_MAX_ENTRIES + 100; index++) dedupe.add(index);

    expect(dedupe.size).toBe(STREAM_DEDUPE_MAX_ENTRIES);
    expect(dedupe.has(0)).toBe(false);
    expect(dedupe.has(STREAM_DEDUPE_MAX_ENTRIES + 99)).toBe(true);

    const active = new BoundedMap<number, string>(2);
    active.set(1, 'one');
    active.set(2, 'two');
    expect(active.set(3, 'three')).toEqual({ key: 1, value: 'one' });
    expect(active.size).toBe(2);
    expect(active.has(1)).toBe(false);
  });
});
