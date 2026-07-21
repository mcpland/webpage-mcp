import { describe, expect, it } from 'vitest';
import { AGENT_SESSION_MAX_THINKING_TOKENS, AGENT_SESSION_MAX_TURNS } from 'webpage-mcp-shared';
import {
  ClaudeEngine,
  resolveClaudeSettingSources,
  validateClaudeExecutionOptionsConfig,
} from './claude';

describe('Claude setting source isolation', () => {
  it('uses SDK isolation mode by default', () => {
    expect(resolveClaudeSettingSources(undefined)).toEqual([]);
    expect(resolveClaudeSettingSources(null)).toEqual([]);
    expect(resolveClaudeSettingSources({})).toEqual([]);
    expect(resolveClaudeSettingSources([])).toEqual([]);
  });

  it('ignores repository-controlled project and local setting sources', () => {
    expect(resolveClaudeSettingSources('project')).toEqual([]);
    expect(resolveClaudeSettingSources(['project'])).toEqual([]);
    expect(resolveClaudeSettingSources(['local'])).toEqual([]);
    expect(resolveClaudeSettingSources(['project', 'local'])).toEqual([]);
  });

  it('allows only an explicit user setting source', () => {
    expect(resolveClaudeSettingSources(['user'])).toEqual(['user']);
    expect(resolveClaudeSettingSources(['project', 'user', 'local', 'user'])).toEqual(['user']);
    expect(resolveClaudeSettingSources(['unknown'])).toEqual([]);
  });
});

describe('Claude persisted work-limit validation', () => {
  it.each(['mcpServers', 'env'] as const)(
    'rejects legacy process-capable %s before loading the SDK',
    async (field) => {
      const optionsConfig = { [field]: {} };
      expect(() => validateClaudeExecutionOptionsConfig(optionsConfig)).toThrow(
        `optionsConfig.${field} is not supported`,
      );
      await expect(
        new ClaudeEngine('runtime-process-option-test').initializeAndRun(
          {
            sessionId: 'legacy-session',
            instruction: 'must fail before SDK loading',
            requestId: 'legacy-request',
            projectRoot: process.cwd(),
            optionsConfig,
          },
          { emit: () => {} },
        ),
      ).rejects.toThrow(`optionsConfig.${field} is not supported`);
    },
  );

  it.each([
    ['maxTurns', AGENT_SESSION_MAX_TURNS],
    ['maxThinkingTokens', AGENT_SESSION_MAX_THINKING_TOKENS],
  ] as const)('rejects legacy %s values before loading the SDK', async (field, maximum) => {
    expect(() => validateClaudeExecutionOptionsConfig({ [field]: maximum })).not.toThrow();
    await expect(
      new ClaudeEngine('runtime-limit-test').initializeAndRun(
        {
          sessionId: 'legacy-session',
          instruction: 'must fail before SDK loading',
          requestId: 'legacy-request',
          projectRoot: process.cwd(),
          optionsConfig: { [field]: maximum + 1 },
        },
        { emit: () => {} },
      ),
    ).rejects.toThrow(`optionsConfig.${field}`);
  });
});
