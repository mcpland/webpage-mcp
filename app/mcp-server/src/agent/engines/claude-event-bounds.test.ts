import { describe, expect, it } from 'vitest';
import {
  AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES,
  AGENT_MESSAGE_CONTENT_MAX_BYTES,
  AGENT_MESSAGE_METADATA_MAX_JSON_BYTES,
} from 'webpage-mcp-shared';
import {
  CLAUDE_AUTH_OUTPUT_MAX_ENTRIES,
  CLAUDE_EVENT_ERROR_MAX_BYTES,
  CLAUDE_EVENT_FIELD_MAX_BYTES,
  CLAUDE_EVENT_LOG_MAX_BYTES,
  CLAUDE_LINE_SCAN_MAX_CODE_UNITS,
  CLAUDE_MANAGEMENT_MAX_ENTRIES_PER_FIELD,
  CLAUDE_MESSAGE_CONTENT_MAX_ENTRIES,
  CLAUDE_SESSION_ID_MAX_BYTES,
  CLAUDE_TOOL_COLLECTION_MAX_ENTRIES,
  boundClaudeEventText,
  boundClaudeLogField,
  buildBoundedClaudeAuthStatus,
  buildBoundedClaudeManagementInfo,
  buildBoundedClaudeResultError,
  buildBoundedClaudeToolMetadata,
  countClaudeLinesBounded,
  extractBoundedClaudeMessageContent,
  extractBoundedClaudeToolResultContent,
  parseBoundedClaudeSessionId,
  pickBoundedClaudeIdentifier,
  pickBoundedClaudeString,
} from './claude-event-bounds';

function virtualArray<T>(
  length: number,
  valueAt: (index: number) => T,
): { value: T[]; reads: () => number } {
  let readCount = 0;
  const target: T[] = [];
  const value = new Proxy(target, {
    get(array, property, receiver) {
      if (property === 'length') return length;
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        readCount += 1;
        return valueAt(Number(property));
      }
      return Reflect.get(array, property, receiver);
    },
  });
  return { value, reads: () => readCount };
}

describe('Claude event text bounds', () => {
  it('retains valid UTF-8 prefixes without encoding the unretained suffix', () => {
    const bounded = boundClaudeEventText('界'.repeat(100_000), 1_024);

    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(1_024);
    expect(bounded.text).toContain('… [truncated]');
    expect(bounded.observedBytes).toBe(1_025);
  });

  it('bounds and flattens attacker-controlled log fields', () => {
    const log = boundClaudeLogField(`first\nsecond\t${'x'.repeat(100_000)}`);

    expect(log).not.toContain('\n');
    expect(log).not.toContain('\t');
    expect(log).toContain('\\n');
    expect(Buffer.byteLength(log, 'utf8')).toBeLessThanOrEqual(
      CLAUDE_EVENT_LOG_MAX_BYTES,
    );
  });

  it('scans only a bounded prefix when picking a nested event field', () => {
    const source = virtualArray(1_000_000, (index) =>
      index === 31 ? 'found' : undefined,
    );

    expect(pickBoundedClaudeString(source.value)).toBe('found');
    expect(source.reads()).toBe(32);
  });

  it('drops oversized or control-bearing tool identifiers instead of marking them', () => {
    expect(pickBoundedClaudeIdentifier('tool-1', 240)).toBe('tool-1');
    expect(pickBoundedClaudeIdentifier('x'.repeat(241), 240)).toBeUndefined();
    expect(pickBoundedClaudeIdentifier('tool\nforged', 240)).toBeUndefined();
  });
});

describe('Claude system:init bounds', () => {
  it('accepts bounded IDs and rejects oversized or log-injecting IDs', () => {
    expect(parseBoundedClaudeSessionId('session-1')).toEqual({
      id: 'session-1',
      rejected: false,
      observedBytes: 9,
    });

    const oversized = parseBoundedClaudeSessionId(
      '界'.repeat(CLAUDE_SESSION_ID_MAX_BYTES),
    );
    expect(oversized.id).toBeUndefined();
    expect(oversized.rejected).toBe(true);
    expect(oversized.observedBytes).toBe(CLAUDE_SESSION_ID_MAX_BYTES + 1);
    const injected = parseBoundedClaudeSessionId('session\nforged');
    expect(injected.id).toBeUndefined();
    expect(injected.rejected).toBe(true);
  });

  it('incrementally caps management arrays and their aggregate JSON', () => {
    const tools = virtualArray(1_000_000, () => '界'.repeat(10_000));
    const management = buildBoundedClaudeManagementInfo({
      model: 'claude-sonnet',
      cwd: '/workspace',
      tools: tools.value,
    });

    expect(tools.reads()).toBeLessThanOrEqual(
      CLAUDE_MANAGEMENT_MAX_ENTRIES_PER_FIELD,
    );
    expect(management.info.tools?.length).toBeGreaterThan(0);
    expect(management.info.tools?.length).toBeLessThanOrEqual(
      CLAUDE_MANAGEMENT_MAX_ENTRIES_PER_FIELD,
    );
    expect(management.truncatedFields).toContain('tools');
    const serializedBytes = Buffer.byteLength(JSON.stringify(management.info), 'utf8');
    expect(serializedBytes).toBe(management.serializedBytes);
    expect(serializedBytes).toBeLessThanOrEqual(
      AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES,
    );
  });

  it('bounds structured plugin and MCP fields before persistence', () => {
    const oversized = `name\u0000${'x'.repeat(100_000)}`;
    const management = buildBoundedClaudeManagementInfo({
      plugins: [{ name: oversized, path: oversized }],
      mcp_servers: [{ name: oversized, status: oversized }],
      slash_commands: ['/review'],
      betas: ['bounded-beta'],
    });

    expect(management.truncated).toBe(true);
    expect(management.truncatedFields).toEqual(
      expect.arrayContaining(['plugins', 'mcpServers']),
    );
    expect(JSON.stringify(management.info)).not.toContain('\\u0000');
    expect(Buffer.byteLength(JSON.stringify(management.info), 'utf8')).toBeLessThanOrEqual(
      AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES,
    );
  });
});

describe('Claude auth status bounds', () => {
  it('caps output entries, text, metadata, and login scanning incrementally', () => {
    const output = virtualArray(1_000_000, (index) =>
      `${index === 0 ? 'Please LOGIN. ' : ''}${'x'.repeat(10_000)}`,
    );
    const auth = buildBoundedClaudeAuthStatus({ output: output.value });

    expect(output.reads()).toBeLessThanOrEqual(CLAUDE_AUTH_OUTPUT_MAX_ENTRIES);
    expect(auth.output.length).toBeLessThanOrEqual(CLAUDE_AUTH_OUTPUT_MAX_ENTRIES);
    expect(auth.requiresLogin).toBe(true);
    expect(auth.truncated).toBe(true);
    expect(Buffer.byteLength(auth.content, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(
      Buffer.byteLength(
        JSON.stringify({ output: auth.output, error: auth.error, truncation: auth.truncation }),
        'utf8',
      ),
    ).toBeLessThanOrEqual(AGENT_MESSAGE_METADATA_MAX_JSON_BYTES);
  });

  it('bounds a large auth error before using it as content or metadata', () => {
    const auth = buildBoundedClaudeAuthStatus({
      error: '\\'.repeat(CLAUDE_EVENT_FIELD_MAX_BYTES * 2),
      output: Array.from({ length: 64 }, () => '"'.repeat(10_000)),
    });

    expect(auth.error).toBe(auth.content);
    expect(auth.truncated).toBe(true);
    expect(Buffer.byteLength(auth.content, 'utf8')).toBeLessThanOrEqual(
      CLAUDE_EVENT_FIELD_MAX_BYTES,
    );
    expect(
      Buffer.byteLength(
        JSON.stringify({ output: auth.output, error: auth.error, truncation: auth.truncation }),
        'utf8',
      ),
    ).toBeLessThanOrEqual(AGENT_MESSAGE_METADATA_MAX_JSON_BYTES);
  });
});

describe('Claude tool event bounds', () => {
  it('bounds edit fields and counts lines without splitting the full input', () => {
    const hugeEdit = 'line\n'.repeat(100_000);
    const metadata = buildBoundedClaudeToolMetadata('Edit', 'tool-1', {
      file_path: `/tmp/${'x'.repeat(100_000)}`,
      old_string: hugeEdit,
      new_string: hugeEdit,
      replace_all: true,
    });

    expect(countClaudeLinesBounded(hugeEdit)).toEqual({
      lines: Math.floor(CLAUDE_LINE_SCAN_MAX_CODE_UNITS / 5) + 1,
      truncated: true,
      scannedCodeUnits: CLAUDE_LINE_SCAN_MAX_CODE_UNITS,
    });
    expect(metadata.truncated).toBe(true);
    expect(metadata.deletedLines).toBeLessThan(100_001);
    expect(Buffer.byteLength(String(metadata.oldString), 'utf8')).toBeLessThanOrEqual(
      4 * 1024,
    );
    expect(Buffer.byteLength(JSON.stringify(metadata), 'utf8')).toBeLessThanOrEqual(
      AGENT_MESSAGE_METADATA_MAX_JSON_BYTES,
    );
  });

  it('summarizes only a bounded prefix of TodoWrite arrays', () => {
    const todos = virtualArray(1_000_000, (index) => ({
      content: `${index}-${'x'.repeat(10_000)}`,
      status: 'pending',
      ignored: { deeply: 'nested' },
    }));
    const metadata = buildBoundedClaudeToolMetadata('TodoWrite', 'tool-2', {
      todos: todos.value,
    });

    expect(todos.reads()).toBeLessThanOrEqual(CLAUDE_TOOL_COLLECTION_MAX_ENTRIES);
    expect((metadata.todos as unknown[])?.length).toBeLessThanOrEqual(
      CLAUDE_TOOL_COLLECTION_MAX_ENTRIES,
    );
    expect(metadata.todoCount).toBe(1_000_000);
    expect(metadata.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(metadata), 'utf8')).toBeLessThanOrEqual(
      AGENT_MESSAGE_METADATA_MAX_JSON_BYTES,
    );
  });

  it('enforces the metadata JSON budget after escape expansion', () => {
    const expanding = '\\'.repeat(100_000);
    const metadata = buildBoundedClaudeToolMetadata('Search', 'tool-3', {
      file_path: expanding,
      pattern: expanding,
      path: expanding,
      glob: expanding,
      output_mode: expanding,
    });

    expect(metadata.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(metadata), 'utf8')).toBeLessThanOrEqual(
      AGENT_MESSAGE_METADATA_MAX_JSON_BYTES,
    );
  });
});

describe('Claude content and result error bounds', () => {
  it('caps assistant content array traversal and combined UTF-8 output', () => {
    const content = virtualArray(1_000_000, () => ({
      type: 'text',
      text: '界'.repeat(10_000),
    }));
    const extracted = extractBoundedClaudeMessageContent({ content: content.value });

    expect(content.reads()).toBe(CLAUDE_MESSAGE_CONTENT_MAX_ENTRIES);
    expect(extracted.truncated).toBe(true);
    expect(extracted.content).toContain('… [truncated]');
    expect(Buffer.byteLength(extracted.content || '', 'utf8')).toBeLessThanOrEqual(
      AGENT_MESSAGE_CONTENT_MAX_BYTES,
    );
  });

  it('caps tool-result traversal and preserves a truncation marker', () => {
    const content = virtualArray(1_000_000, () => ({
      type: 'text',
      text: 'result',
    }));
    const extracted = extractBoundedClaudeToolResultContent({ content: content.value });

    expect(content.reads()).toBe(CLAUDE_MESSAGE_CONTENT_MAX_ENTRIES);
    expect(extracted.truncated).toBe(true);
    expect(extracted.content).toContain('… [truncated]');
  });

  it('caps error array traversal and aggregate error text', () => {
    const errors = virtualArray(1_000_000, () => '界'.repeat(10_000));
    const message = buildBoundedClaudeResultError(errors.value, undefined);

    expect(errors.reads()).toBe(32);
    expect(message).toContain('… [truncated]');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(
      CLAUDE_EVENT_ERROR_MAX_BYTES,
    );
  });
});
