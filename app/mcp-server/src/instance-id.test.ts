import { describe, expect, it } from 'vitest';
import { DEFAULT_MCP_INSTANCE_ID, NativeMessageType } from 'webpage-mcp-shared';
import { resolveInstanceId } from './instance-id';
import { NativeMessagingHost } from './native-messaging-host';
import { NativeMessageWriter } from './native-message-output';
import { Server } from './server';
import { Writable } from 'node:stream';

function createQuietHost(): NativeMessagingHost {
  const output = new Writable({
    write: (_chunk, _encoding, callback) => callback(),
  });
  return new NativeMessagingHost(new NativeMessageWriter(output));
}

describe('instance id validation', () => {
  it('uses the default only when instanceId is omitted', () => {
    expect(resolveInstanceId(undefined)).toBe(DEFAULT_MCP_INSTANCE_ID);
    expect(resolveInstanceId(' custom.instance-1 ')).toBe('custom.instance-1');
  });

  it.each([null, '', '   ', '../default', 'instance/name', 'a'.repeat(65), ' '.repeat(129), 42])(
    'rejects an explicitly supplied malformed instanceId: %s',
    (instanceId) => {
      expect(() => resolveInstanceId(instanceId)).toThrow('Invalid instanceId');
    },
  );

  it('prevents direct Server construction with an invalid instanceId', () => {
    expect(() => new Server({ instanceId: '../default' })).toThrow('Invalid instanceId');
    expect(new Server().instanceId).toBe(DEFAULT_MCP_INSTANCE_ID);
  });

  it('rejects invalid native start, stop, sync, and agent RPC directives', () => {
    const host = createQuietHost();
    const internal = host as unknown as {
      resolveStartDirective(payload: unknown): { instanceId: string };
      resolveStopDirective(payload: unknown): { instanceId: string };
      resolveSyncDirective(payload: unknown): unknown;
      parseAgentRpcPayload(payload: unknown): unknown;
    };

    expect(internal.resolveStartDirective({})).toEqual({
      instanceId: DEFAULT_MCP_INSTANCE_ID,
    });
    expect(internal.resolveStopDirective(undefined)).toEqual({
      instanceId: DEFAULT_MCP_INSTANCE_ID,
    });
    expect(() => internal.resolveStartDirective({ instanceId: '../default' })).toThrow('Invalid instanceId');
    expect(() => internal.resolveStopDirective({ instanceId: null })).toThrow('Invalid instanceId');
    expect(() =>
      internal.resolveSyncDirective({
        instances: [{ instanceId: 'bad/id', enabled: true, autoStart: true }],
      }),
    ).toThrow('Invalid instanceId');
    expect(() =>
      internal.parseAgentRpcPayload({
        instanceId: '',
        operation: 'health.ping',
      }),
    ).toThrow('Invalid instanceId');
  });

  it('returns an explicit native directive error instead of targeting default', async () => {
    const host = createQuietHost();
    const responses: Array<{ requestId: string; error?: string }> = [];
    const internal = host as unknown as {
      handleMessage(message: unknown): Promise<void>;
      sendRequestResponse(requestId: string, payload?: unknown, error?: string): void;
    };
    internal.sendRequestResponse = (requestId, _payload, error) => {
      responses.push({ requestId, error });
    };

    await internal.handleMessage({
      type: NativeMessageType.START,
      requestId: 'invalid-start',
      payload: { instanceId: '../default' },
    });

    expect(responses).toEqual([
      {
        requestId: 'invalid-start',
        error: expect.stringContaining('Invalid instanceId'),
      },
    ]);
  });

  it('rejects an invalid IPC instanceId while allowing omission for ping', async () => {
    const host = createQuietHost();
    const handleIpcRequest = (
      host as unknown as {
        handleIpcRequest(request: unknown): Promise<unknown>;
      }
    ).handleIpcRequest.bind(host);

    await expect(handleIpcRequest({ method: 'ping', params: {} })).resolves.toEqual({ ok: true });
    await expect(
      handleIpcRequest({
        method: 'ping',
        params: { instanceId: 'bad/id' },
      }),
    ).rejects.toThrow('Invalid instanceId');
  });
});
