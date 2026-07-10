import { describe, expect, it } from 'vitest';
import { createAgentEventDedupKey } from './event-dedupe';

describe('createAgentEventDedupKey', () => {
  it('distinguishes tool results that share the same message prefix', () => {
    const first = createAgentEventDedupKey('tool_result:first output:{}:session:request');
    const second = createAgentEventDedupKey(
      'tool_result:completely different output:{}:session:request',
    );

    expect(first).not.toBe(second);
  });

  it('distinguishes tool uses whose descriptions start the same way', () => {
    const first = createAgentEventDedupKey('tool_use:Running ls:{"tool":"shell"}:session:request');
    const second = createAgentEventDedupKey(
      'tool_use:Running tests:{"tool":"shell"}:session:request',
    );

    expect(first).not.toBe(second);
  });

  it('is stable for a repeated event payload', () => {
    const value = 'tool_result:stable:{"toolUseId":"1"}:session:request';
    expect(createAgentEventDedupKey(value)).toBe(createAgentEventDedupKey(value));
  });
});
