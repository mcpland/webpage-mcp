import { describe, expect, it } from 'vitest';
import { resolveClaudeSettingSources } from './claude';

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
