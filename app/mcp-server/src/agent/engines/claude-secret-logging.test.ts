import { describe, expect, it } from 'vitest';
import {
  describeClaudeAuthTokenConfiguration,
  parseClaudeToolInputForEvent,
} from './claude';

describe('Claude secret logging', () => {
  it('reports token presence without exposing any token characters', () => {
    const token = 'sk-ant-sensitive-prefix-and-suffix';
    const message = describeClaudeAuthTokenConfiguration(token);

    expect(message).toBe('[ClaudeEngine] ANTHROPIC_AUTH_TOKEN is configured');
    expect(message).not.toContain(token.slice(0, 4));
    expect(message).not.toContain(token.slice(-4));
  });

  it('does not log an absent token', () => {
    expect(describeClaudeAuthTokenConfiguration(undefined)).toBeNull();
    expect(describeClaudeAuthTokenConfiguration('')).toBeNull();
  });

  it('logs only metadata for valid tool input containing a secret', () => {
    const secret = 'tool-input-secret-that-must-not-reach-stderr';
    const text = JSON.stringify({ selector: '#password', value: secret });
    const bytes = Buffer.byteLength(text, 'utf8');

    const parsed = parseClaudeToolInputForEvent('chrome_fill', {
      text,
      truncated: false,
      originalBytes: bytes,
      retainedBytes: bytes,
    });

    expect(parsed.input).toEqual({ selector: '#password', value: secret });
    expect(parsed.logMessage).toContain('toolName: chrome_fill');
    expect(parsed.logMessage).toContain(`inputBytes: ${bytes}`);
    expect(parsed.logMessage).toContain('truncated: false, parseStatus: parsed');
    expect(parsed.logMessage).not.toContain(secret);
    expect(parsed.logMessage).not.toContain('#password');
  });

  it('does not leak malformed tool input through a JSON parse error', () => {
    const secret = 'malformed-tool-input-secret';
    const text = `{"value":"${secret}"`;
    const bytes = Buffer.byteLength(text, 'utf8');

    const parsed = parseClaudeToolInputForEvent('chrome_fill', {
      text,
      truncated: false,
      originalBytes: bytes,
      retainedBytes: bytes,
    });

    expect(parsed.input).toEqual({});
    expect(parsed.logMessage).toContain('parseStatus: invalid');
    expect(parsed.logMessage).not.toContain(secret);
  });

  it('keeps truncated tool-input diagnostics bounded and metadata-only', () => {
    const secret = 'truncated-tool-input-secret';
    const parsed = parseClaudeToolInputForEvent(`tool-${'x'.repeat(4_096)}`, {
      text: `{"value":"${secret}"}`,
      truncated: true,
      originalBytes: 128 * 1024,
      retainedBytes: 64 * 1024,
    });

    expect(parsed.input).toEqual({});
    expect(parsed.logMessage).toContain('truncated: true, parseStatus: skipped-truncated');
    expect(parsed.logMessage).not.toContain(secret);
    expect(Buffer.byteLength(parsed.logMessage, 'utf8')).toBeLessThanOrEqual(512);
  });
});
