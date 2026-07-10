import { describe, expect, it, vi } from 'vitest';

import { projectAndValidateWorkflowOutputs } from '@/entrypoints/background/record-replay-v3/flows/output-validation';
import { ifHandler } from '@/entrypoints/background/record-replay/actions/handlers/control-flow';
import {
  testWorkflowRegex,
  validateWorkflowRegexPattern,
  WORKFLOW_REGEX_INPUT_MAX_UTF8_BYTES,
  WORKFLOW_REGEX_PATTERN_MAX_UTF8_BYTES,
} from '@/entrypoints/background/record-replay/workflow-regex';

function createOutputFlow(pattern: string) {
  return {
    meta: {
      exposedOutputs: [
        {
          nodeId: 'extract-1',
          as: 'accountId',
          path: ['value'],
          allowPlaintext: true,
          schema: { type: 'string', pattern },
        },
      ],
    },
  } as any;
}

function createIfAction(pattern: string) {
  return {
    id: 'if-regex',
    type: 'if',
    params: {
      mode: 'binary',
      condition: {
        kind: 'compare',
        left: { kind: 'var', ref: { name: 'value' } },
        op: 'regex',
        right: pattern,
      },
    },
  } as any;
}

function createActionContext(value: string) {
  return {
    vars: { value },
    log: vi.fn(),
  } as any;
}

describe('workflow regex guard', () => {
  it('keeps ordinary anchors, character classes, groups, and simple alternation', () => {
    const cases = [
      ['^acct_[0-9]+$', 'acct_123'],
      ['^(foo|bar)$', 'bar'],
      ['^(ab)+$', 'abab'],
      ['^https?://[^/]+$', 'https://example.com'],
      ['^\\d+-\\d+$', '12-34'],
      ['^[^/]+/[^/]+$', 'docs/readme'],
      ['^a+ba+$', 'aaabaaa'],
    ] as const;

    for (const [pattern, input] of cases) {
      expect(validateWorkflowRegexPattern(pattern)).toEqual({ ok: true });
      expect(testWorkflowRegex(pattern, input)).toEqual({ ok: true, matched: true });
    }
    expect(testWorkflowRegex('^acct_[0-9]+$', 'acct_bad')).toEqual({
      ok: true,
      matched: false,
    });
    expect(testWorkflowRegex('^\\p{L}+$', '中文', 'u')).toEqual({
      ok: true,
      matched: true,
    });
    expect(testWorkflowRegex('^\\w+\\s+\\w+$', 'hello world')).toEqual({
      ok: true,
      matched: true,
    });
    expect(testWorkflowRegex('^\\u{61}+$', 'aaaa', 'u')).toEqual({
      ok: true,
      matched: true,
    });
  });

  it.each([
    ['nested quantifier', '(a+)+$'],
    ['quantified alternation', '(a|aa)+$'],
    ['numeric backreference', '^(a)\\1$'],
    ['named backreference', '^(?<letter>a)\\k<letter>$'],
    ['lookahead', 'a(?=b)'],
    ['lookbehind', '(?<=a)b'],
    ['adjacent repetitions', 'a+a+$'],
    ['escaped adjacent repetitions', '^\\x61+\\x61+\\x61+\\x62$'],
    ['separated overlapping repetitions', '^[a-z]*a[a-z]*b$'],
    ['escaped separated repetitions', '^[\\x61-\\x7a]*\\x61[\\x61-\\x7a]*\\x62$'],
    ['overlapping optional atoms', 'a?a?b'],
    ['transparent repeated group', '(a+)a+$'],
    ['adjacent Unicode property repetitions', '\\p{L}+\\p{L}+', 'u'],
    ['repeated wildcard', '.*value.*'],
    ['repeated universal class', '[\\s\\S]*value[\\s\\S]*'],
    ['oversized finite repetition', 'a{1001}'],
    ['oversized unbounded minimum', 'a{1001,}'],
  ] as Array<[string, string, string?]>)('rejects %s before matching', (_name, pattern, flags) => {
    const result = testWorkflowRegex(pattern, 'a'.repeat(32) + '!', flags);
    expect(result).toMatchObject({ ok: false, code: 'WORKFLOW_REGEX_UNSAFE' });
    if (!result.ok) {
      expect(result.message.length).toBeLessThan(256);
      expect(result.message).not.toContain(pattern);
    }
  });

  it('rejects invalid syntax and UTF-8 byte overflows before execution', () => {
    expect(testWorkflowRegex('[', 'value')).toMatchObject({
      ok: false,
      code: 'WORKFLOW_REGEX_INVALID',
    });

    const oversizedPattern = '界'.repeat(
      Math.floor(WORKFLOW_REGEX_PATTERN_MAX_UTF8_BYTES / 3) + 1,
    );
    expect(testWorkflowRegex(oversizedPattern, 'value')).toMatchObject({
      ok: false,
      code: 'WORKFLOW_REGEX_PATTERN_TOO_LARGE',
    });

    const oversizedInput = '界'.repeat(
      Math.floor(WORKFLOW_REGEX_INPUT_MAX_UTF8_BYTES / 3) + 1,
    );
    expect(testWorkflowRegex('^value$', oversizedInput)).toMatchObject({
      ok: false,
      code: 'WORKFLOW_REGEX_INPUT_TOO_LARGE',
    });
  });
});

describe('workflow regex execution paths', () => {
  it('returns a bounded validation error from control-flow conditions', async () => {
    const result = await ifHandler.run(
      createActionContext('a'.repeat(32) + '!'),
      createIfAction('(a+)+$'),
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'VALIDATION_ERROR',
      },
    });
    if (result.status === 'failed') {
      const message = result.error?.message ?? '';
      expect(message).toContain('WORKFLOW_REGEX_UNSAFE');
      expect(message).not.toContain('(a+)+$');
      expect(message.length).toBeLessThan(320);
    }
  });

  it('keeps normal control-flow regex comparisons working', async () => {
    const result = await ifHandler.run(
      createActionContext('acct_123'),
      createIfAction('^acct_[0-9]+$'),
    );
    expect(result).toMatchObject({ status: 'success', nextLabel: 'true' });
  });

  it('returns distinct output-schema errors for unsafe, invalid, and oversized input', () => {
    const unsafe = projectAndValidateWorkflowOutputs(
      createOutputFlow('(a|aa)+$'),
      { 'extract-1': { value: 'aaaa!' } },
    );
    expect(unsafe.errors).toEqual([
      expect.objectContaining({ code: 'OUTPUT_SCHEMA_UNSAFE_PATTERN' }),
    ]);

    const invalid = projectAndValidateWorkflowOutputs(
      createOutputFlow('['),
      { 'extract-1': { value: 'value' } },
    );
    expect(invalid.errors).toEqual([
      expect.objectContaining({ code: 'OUTPUT_SCHEMA_INVALID_PATTERN' }),
    ]);

    const oversizedInput = 'a'.repeat(WORKFLOW_REGEX_INPUT_MAX_UTF8_BYTES + 1);
    const oversized = projectAndValidateWorkflowOutputs(
      createOutputFlow('^a+$'),
      { 'extract-1': { value: oversizedInput } },
    );
    expect(oversized.errors).toEqual([
      expect.objectContaining({ code: 'OUTPUT_SCHEMA_PATTERN_INPUT_TOO_LARGE' }),
    ]);
    expect(oversized.errors[0]?.message).not.toContain(oversizedInput);
  });

  it('keeps normal output-schema pattern validation working', () => {
    expect(
      projectAndValidateWorkflowOutputs(
        createOutputFlow('^acct_[0-9]+$'),
        { 'extract-1': { value: 'acct_123' } },
      ),
    ).toMatchObject({ ok: true, outputs: { accountId: 'acct_123' } });
  });
});
