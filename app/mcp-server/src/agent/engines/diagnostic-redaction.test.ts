import { describe, expect, it } from 'vitest';
import {
  BoundedDiagnosticBuffer,
  DIAGNOSTIC_BUFFER_MAX_BYTES,
  DIAGNOSTIC_BUFFER_MAX_LINES,
  DIAGNOSTIC_ERROR_MAX_BYTES,
  DIAGNOSTIC_LINE_MAX_BYTES,
  createRedactedDiagnosticError,
  redactDiagnosticText,
} from './diagnostic-redaction';

describe('diagnostic redaction', () => {
  it('redacts common headers, assignments, known tokens, JWTs, and URL userinfo', () => {
    const secrets = [
      'bearer-value-123',
      'api-value-123',
      'client-secret-123',
      'password value 123',
      'cookie-value-123',
      'set-cookie-value-123',
      'router-user',
      'router-password',
      'cli-token-123',
      'sk-ant-api03-standalone-secret-123',
      'abcdefghij.klmnopqrst.uvwxyzABCD',
    ];
    const raw = [
      `Authorization: Bearer ${secrets[0]}`,
      `x-api-key="${secrets[1]}"`,
      `clientSecret=${secrets[2]}`,
      `password: '${secrets[3]}'`,
      `Cookie: sid=${secrets[4]}; theme=dark`,
      `Set-Cookie: refresh=${secrets[5]}; HttpOnly`,
      `proxy=https://${secrets[6]}:${secrets[7]}@example.test/v1`,
      `--token ${secrets[8]}`,
      secrets[9],
      secrets[10],
      'network connection refused; retry after 5 seconds',
    ].join('\n');

    const redacted = redactDiagnosticText(raw, DIAGNOSTIC_ERROR_MAX_BYTES);

    for (const secret of secrets) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).toContain('network connection refused; retry after 5 seconds');
  });

  it('redacts a sensitive assignment split across chunks before retaining a line', () => {
    const buffer = new BoundedDiagnosticBuffer();
    const secret = 'split-bearer-secret-123';

    expect(buffer.push('Authoriz')).toEqual([]);
    const emitted = buffer.push(`ation: Bearer ${secret}\nnetwork unreachable\n`);

    expect(emitted).toHaveLength(2);
    expect(emitted.join('\n')).not.toContain(secret);
    expect(emitted[0]).toContain('Authorization: [REDACTED]');
    expect(emitted[1]).toBe('network unreachable');
    expect(buffer.snapshot().join('\n')).not.toContain(secret);
  });

  it('bounds one line and the retained line and byte totals', () => {
    const buffer = new BoundedDiagnosticBuffer();
    const oversizedSecret = 'oversized-password-secret';
    buffer.push(Buffer.from(`password=${oversizedSecret}${'x'.repeat(256 * 1024)}`));
    buffer.flush();
    for (let index = 0; index < DIAGNOSTIC_BUFFER_MAX_LINES * 3; index += 1) {
      buffer.push(`line-${index} token=secret-${index}\n`);
    }

    const snapshot = buffer.snapshot();
    expect(snapshot.length).toBeLessThanOrEqual(DIAGNOSTIC_BUFFER_MAX_LINES);
    expect(Buffer.byteLength(snapshot.join('\n'), 'utf8')).toBeLessThanOrEqual(
      DIAGNOSTIC_BUFFER_MAX_BYTES,
    );
    expect(
      Math.max(...snapshot.map((line) => Buffer.byteLength(line, 'utf8'))),
    ).toBeLessThanOrEqual(DIAGNOSTIC_LINE_MAX_BYTES);
    expect(snapshot.join('\n')).not.toContain(oversizedSecret);
    expect(snapshot.join('\n')).not.toMatch(/secret-\d+/);
  });

  it('creates a bounded error that keeps useful text but drops secret values', () => {
    const secret = 'final-error-token-value';
    const rawError = new Error(`request failed: token=${secret}; connection reset`);
    rawError.name = `token=${secret}`;
    const error = createRedactedDiagnosticError(rawError);

    expect(error.message).not.toContain(secret);
    expect(error.name).not.toContain(secret);
    expect(error.message).toContain('connection reset');
    expect(Buffer.byteLength(error.message, 'utf8')).toBeLessThanOrEqual(
      DIAGNOSTIC_ERROR_MAX_BYTES,
    );
  });
});
