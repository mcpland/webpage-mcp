import { describe, expect, it } from 'vitest';
import { describeClaudeAuthTokenConfiguration } from './claude';

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
});
