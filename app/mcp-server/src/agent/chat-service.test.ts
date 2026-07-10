import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEngine, EngineInitOptions } from './engines/types';
import { AgentStreamManager } from './stream-manager';
import type { AgentSession } from './session-service';
import {
  AGENT_CLIENT_META_MAX_JSON_BYTES,
  AGENT_DISPLAY_TEXT_MAX_BYTES,
  AGENT_MESSAGE_CONTENT_MAX_BYTES,
} from 'webpage-mcp-shared';
import { AGENT_PAYLOAD_INVALID, AGENT_PAYLOAD_TOO_LARGE } from './payload-limits';

const projectServiceMocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  touchProjectActivity: vi.fn(),
  updateProjectClaudeSessionId: vi.fn(),
}));

const messageServiceMocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
}));

const sessionServiceMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateEngineSessionId: vi.fn(),
  updateManagementInfo: vi.fn(),
  updateSessionEngineName: vi.fn(),
  touchSessionActivity: vi.fn(),
}));

const attachmentServiceMocks = vi.hoisted(() => ({
  saveAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));

vi.mock('./project-service', () => projectServiceMocks);
vi.mock('./message-service', () => messageServiceMocks);
vi.mock('./session-service', async () => {
  const actual = await vi.importActual<typeof import('./session-service')>('./session-service');
  return {
    ...actual,
    getSession: sessionServiceMocks.getSession,
    updateEngineSessionId: sessionServiceMocks.updateEngineSessionId,
    updateManagementInfo: sessionServiceMocks.updateManagementInfo,
    updateSessionEngineName: sessionServiceMocks.updateSessionEngineName,
    touchSessionActivity: sessionServiceMocks.touchSessionActivity,
  };
});
vi.mock('./attachment-service', () => ({
  attachmentService: {
    saveAttachment: attachmentServiceMocks.saveAttachment,
    deleteAttachment: attachmentServiceMocks.deleteAttachment,
  },
}));

import { AgentChatService } from './chat-service';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('AgentChatService', () => {
  const legacySession: AgentSession = {
    id: 'legacy-db-session',
    projectId: 'project-1',
    engineName: 'cursor',
    engineSessionId: 'cursor-session-123',
    model: 'cursor-proprietary-model',
    name: 'Legacy Cursor Session',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    createdAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
  };
  const alternateSession: AgentSession = {
    id: 'second-db-session',
    projectId: 'project-2',
    engineName: 'claude',
    engineSessionId: undefined,
    model: undefined,
    name: 'Second Session',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    createdAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    legacySession.engineName = 'cursor';
    legacySession.engineSessionId = 'cursor-session-123';
    legacySession.model = 'cursor-proprietary-model';

    projectServiceMocks.getProject.mockImplementation(async (projectId: string) => {
      if (projectId === 'project-1') {
        return {
          id: 'project-1',
          name: 'Project',
          rootPath: process.cwd(),
          preferredCli: 'claude',
          createdAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
          updatedAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
        };
      }
      if (projectId === 'project-2') {
        return {
          id: 'project-2',
          name: 'Project Two',
          rootPath: process.cwd(),
          preferredCli: 'claude',
          createdAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
          updatedAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
        };
      }
      return undefined;
    });
    projectServiceMocks.touchProjectActivity.mockResolvedValue(undefined);
    projectServiceMocks.updateProjectClaudeSessionId.mockResolvedValue(undefined);
    messageServiceMocks.createMessage.mockResolvedValue(undefined);
    sessionServiceMocks.getSession.mockImplementation(async (sessionId: string) => {
      if (sessionId === legacySession.id) {
        return legacySession;
      }
      if (sessionId === alternateSession.id) {
        return alternateSession;
      }
      return undefined;
    });
    sessionServiceMocks.updateEngineSessionId.mockResolvedValue(undefined);
    sessionServiceMocks.updateManagementInfo.mockResolvedValue(undefined);
    sessionServiceMocks.updateSessionEngineName.mockResolvedValue(undefined);
    sessionServiceMocks.touchSessionActivity.mockResolvedValue(undefined);
    attachmentServiceMocks.deleteAttachment.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      name: 'oversized UTF-8 input',
      payload: { instruction: 'a'.repeat(AGENT_MESSAGE_CONTENT_MAX_BYTES + 1) },
      code: AGENT_PAYLOAD_TOO_LARGE,
      field: 'instruction',
    },
    {
      name: 'unserializable metadata',
      payload: (() => {
        const clientMeta: Record<string, unknown> = {};
        clientMeta.self = clientMeta;
        return { instruction: 'hello', clientMeta };
      })(),
      code: AGENT_PAYLOAD_INVALID,
      field: 'clientMeta',
    },
    {
      name: 'oversized canonical metadata',
      payload: {
        instruction: 'hello',
        projectId: 'project-1',
        clientMeta: {
          value: 'a'.repeat(
            AGENT_CLIENT_META_MAX_JSON_BYTES - JSON.stringify({ value: '' }).length,
          ),
        },
        displayText: '\u0000'.repeat(AGENT_DISPLAY_TEXT_MAX_BYTES),
        attachments: [
          {
            type: 'image' as const,
            name: 'context.png',
            mimeType: 'image/png',
            dataBase64: 'eA==',
          },
        ],
      },
      code: AGENT_PAYLOAD_TOO_LARGE,
      field: 'metadata',
    },
  ])('rejects $name before reserving or producing side effects', async ({ payload, code, field }) => {
    const run = vi.fn();
    const streamManager = new AgentStreamManager();
    const streamedEvents: unknown[] = [];
    streamManager.addListener(legacySession.id, (event) => streamedEvents.push(event));
    const service = new AgentChatService({
      engines: [{ name: 'claude', supportsMcp: true, initializeAndRun: run }],
      streamManager,
    });

    await expect(service.handleAct(legacySession.id, payload)).rejects.toMatchObject({ code, field });

    expect(service.getRunningExecutions()).toHaveLength(0);
    expect(sessionServiceMocks.getSession).not.toHaveBeenCalled();
    expect(projectServiceMocks.getProject).not.toHaveBeenCalled();
    expect(attachmentServiceMocks.saveAttachment).not.toHaveBeenCalled();
    expect(messageServiceMocks.createMessage).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(streamedEvents).toEqual([]);
  });

  it('does not forward legacy engine-specific state when migrating a session onto Claude', async () => {
    let capturedOptions: EngineInitOptions | undefined;
    const claudeEngine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options) {
        capturedOptions = options;
      },
    };

    const service = new AgentChatService({
      engines: [claudeEngine],
      streamManager: new AgentStreamManager(),
    });

    await service.handleAct('runtime-session-1', {
      instruction: 'Say hello',
      dbSessionId: legacySession.id,
    });

    await vi.waitFor(() => {
      expect(capturedOptions).toBeDefined();
    });

    expect(sessionServiceMocks.updateSessionEngineName).toHaveBeenCalledWith(
      legacySession.id,
      'claude',
    );
    expect(legacySession.engineName).toBe('claude');
    expect(legacySession.engineSessionId).toBeUndefined();
    expect(legacySession.model).toBeUndefined();
    expect(capturedOptions?.resumeClaudeSessionId).toBeUndefined();
    expect(capturedOptions?.model).toBeUndefined();
  });

  it('forwards quick-panel context to the engine without changing persisted user content', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;

    let capturedOptions: EngineInitOptions | undefined;
    const claudeEngine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options) {
        capturedOptions = options;
      },
    };

    const service = new AgentChatService({
      engines: [claudeEngine],
      streamManager: new AgentStreamManager(),
    });

    await service.handleAct(legacySession.id, {
      instruction: 'Review this UI',
      dbSessionId: legacySession.id,
      context: {
        pageUrl: 'https://example.com/settings',
        selectedText: 'Save changes',
      },
    });

    await vi.waitFor(() => {
      expect(capturedOptions).toBeDefined();
    });

    expect(capturedOptions?.instruction).toContain('Review this UI');
    expect(capturedOptions?.instruction).toContain('Additional page context:');
    expect(capturedOptions?.instruction).toContain('Page URL: https://example.com/settings');
    expect(capturedOptions?.instruction).toContain('Save changes');
    expect(messageServiceMocks.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Review this UI',
      }),
    );
  });

  it('does not cancel a running execution when the session id does not match', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;

    let resolveRun: (() => void) | undefined;
    const claudeEngine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options) {
        await new Promise<void>((resolve) => {
          resolveRun = resolve;
          options.signal?.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        });
      },
    };

    const service = new AgentChatService({
      engines: [claudeEngine],
      streamManager: new AgentStreamManager(),
    });

    await service.handleAct(legacySession.id, {
      instruction: 'Keep running',
      dbSessionId: legacySession.id,
      requestId: 'req-cancel-scope',
    });

    await vi.waitFor(() => {
      expect(service.getRunningExecutions()).toHaveLength(1);
    });

    expect(service.cancelExecution('other-session', 'req-cancel-scope')).toBe(false);
    expect(service.getRunningExecutions()).toHaveLength(1);

    expect(service.cancelExecution(legacySession.id, 'req-cancel-scope')).toBe(true);

    await vi.waitFor(() => {
      expect(service.getRunningExecutions()).toHaveLength(0);
    });

    resolveRun?.();
  });

  it('allows the same requestId in different sessions while rejecting duplicates in one session', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;

    const claudeEngine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options) {
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
        });
      },
    };

    const service = new AgentChatService({
      engines: [claudeEngine],
      streamManager: new AgentStreamManager(),
    });

    await service.handleAct(legacySession.id, {
      instruction: 'Run one',
      dbSessionId: legacySession.id,
      requestId: 'shared-request-id',
    });
    await service.handleAct(alternateSession.id, {
      instruction: 'Run two',
      dbSessionId: alternateSession.id,
      requestId: 'shared-request-id',
    });

    await vi.waitFor(() => {
      expect(service.getRunningExecutions()).toHaveLength(2);
    });

    const persistedMessageCount = messageServiceMocks.createMessage.mock.calls.length;
    const touchedProjectCount = projectServiceMocks.touchProjectActivity.mock.calls.length;
    const savedAttachmentCount = attachmentServiceMocks.saveAttachment.mock.calls.length;

    await expect(
      service.handleAct(legacySession.id, {
        instruction: 'Duplicate run',
        dbSessionId: legacySession.id,
        requestId: 'shared-request-id',
        attachments: [
          {
            type: 'image',
            name: 'must-not-be-saved.png',
            mimeType: 'image/png',
            dataBase64: 'ZmFrZQ==',
          },
        ],
      }),
    ).rejects.toThrow('requestId is already active for this session');

    expect(messageServiceMocks.createMessage).toHaveBeenCalledTimes(persistedMessageCount);
    expect(projectServiceMocks.touchProjectActivity).toHaveBeenCalledTimes(touchedProjectCount);
    expect(attachmentServiceMocks.saveAttachment).toHaveBeenCalledTimes(savedAttachmentCount);

    expect(service.cancelAllExecutions()).toBe(2);

    await vi.waitFor(() => {
      expect(service.getRunningExecutions()).toHaveLength(0);
    });
  });

  it('does not persist late assistant messages after the session execution is cancelled', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;

    const lateReply = 'late assistant reply';
    const claudeEngine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options, ctx) {
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              ctx.emit({
                type: 'message',
                data: {
                  id: 'assistant-late-message',
                  sessionId: legacySession.id,
                  role: 'assistant',
                  content: lateReply,
                  messageType: 'chat',
                  cliSource: 'claude',
                  requestId: 'req-late-message',
                  isStreaming: false,
                  isFinal: true,
                  createdAt: new Date().toISOString(),
                },
              });
              resolve();
            },
            { once: true },
          );
        });
      },
    };

    const streamManager = new AgentStreamManager();
    const streamedContents: string[] = [];
    streamManager.addListener(legacySession.id, (event) => {
      if (event.type === 'message' && event.data?.content) {
        streamedContents.push(event.data.content);
      }
    });
    const service = new AgentChatService({
      engines: [claudeEngine],
      streamManager,
    });

    await service.handleAct(legacySession.id, {
      instruction: 'Start and cancel',
      dbSessionId: legacySession.id,
      requestId: 'req-late-message',
    });

    await vi.waitFor(() => {
      expect(service.getRunningExecutions()).toHaveLength(1);
    });

    expect(service.cancelSessionExecutions(legacySession.id)).toBe(1);

    await vi.waitFor(() => {
      expect(service.getRunningExecutions()).toHaveLength(0);
    });

    expect(messageServiceMocks.createMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        content: lateReply,
      }),
    );
    expect(streamedContents).not.toContain(lateReply);
  });

  it('keeps a cancelled requestId reserved until the old engine settles', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;

    let releaseCancelledRun: (() => void) | undefined;
    let invocationCount = 0;
    const claudeEngine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options) {
        invocationCount += 1;
        if (invocationCount > 1) return;
        await new Promise<void>((resolve) => {
          releaseCancelledRun = resolve;
          options.signal?.addEventListener('abort', () => {}, { once: true });
        });
      },
    };

    const service = new AgentChatService({
      engines: [claudeEngine],
      streamManager: new AgentStreamManager(),
    });
    const payload = {
      instruction: 'Run with a reusable id',
      dbSessionId: legacySession.id,
      requestId: 'req-reuse-after-cancel',
    };

    await service.handleAct(legacySession.id, payload);
    await vi.waitFor(() => expect(service.getRunningExecutions()).toHaveLength(1));

    expect(service.cancelExecution(legacySession.id, payload.requestId)).toBe(true);
    expect(service.getRunningExecutions()).toHaveLength(0);
    await expect(service.handleAct(legacySession.id, payload)).rejects.toThrow(
      'requestId is already active for this session',
    );

    releaseCancelledRun?.();
    await vi.waitFor(async () => {
      await expect(service.handleAct(legacySession.id, payload)).resolves.toEqual({
        requestId: payload.requestId,
      });
    });
  });

  it('rolls back earlier files when an attachment batch fails', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const run = vi.fn();
    const service = new AgentChatService({
      engines: [{ name: 'claude', supportsMcp: true, initializeAndRun: run }],
      streamManager: new AgentStreamManager(),
    });
    attachmentServiceMocks.saveAttachment
      .mockResolvedValueOnce({
        absolutePath: '/private/first.png',
        filename: 'first.png',
        metadata: { filename: 'first.png' },
      })
      .mockRejectedValueOnce(new Error('disk full'));

    await expect(
      service.handleAct(legacySession.id, {
        instruction: 'Inspect both images',
        dbSessionId: legacySession.id,
        attachments: [
          {
            type: 'image',
            name: 'first.png',
            mimeType: 'image/png',
            dataBase64: 'Zmlyc3Q=',
          },
          {
            type: 'image',
            name: 'second.png',
            mimeType: 'image/png',
            dataBase64: 'c2Vjb25k',
          },
        ],
      }),
    ).rejects.toThrow('Failed to save attachments: disk full');

    expect(attachmentServiceMocks.deleteAttachment).toHaveBeenCalledWith(
      'project-1',
      'first.png',
    );
    expect(messageServiceMocks.createMessage).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('rolls back files when their message metadata cannot be persisted', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const streamManager = new AgentStreamManager();
    const streamedMessages: string[] = [];
    streamManager.addListener(legacySession.id, (event) => {
      if (event.type === 'message' && event.data?.content) streamedMessages.push(event.data.content);
    });
    const run = vi.fn();
    const service = new AgentChatService({
      engines: [{ name: 'claude', supportsMcp: true, initializeAndRun: run }],
      streamManager,
    });
    attachmentServiceMocks.saveAttachment.mockResolvedValueOnce({
      absolutePath: '/private/first.png',
      filename: 'first.png',
      metadata: { filename: 'first.png' },
    });
    messageServiceMocks.createMessage.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      service.handleAct(legacySession.id, {
        instruction: 'Inspect this image',
        dbSessionId: legacySession.id,
        attachments: [
          {
            type: 'image',
            name: 'first.png',
            mimeType: 'image/png',
            dataBase64: 'Zmlyc3Q=',
          },
        ],
      }),
    ).rejects.toThrow('Failed to persist message attachments: database unavailable');

    expect(attachmentServiceMocks.deleteAttachment).toHaveBeenCalledWith(
      'project-1',
      'first.png',
    );
    expect(streamedMessages).not.toContain('Inspect this image');
    expect(run).not.toHaveBeenCalled();
  });

  it('never starts the engine when a user message without attachments cannot be persisted', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const run = vi.fn();
    const service = new AgentChatService({
      engines: [{ name: 'claude', supportsMcp: true, initializeAndRun: run }],
      streamManager: new AgentStreamManager(),
    });
    messageServiceMocks.createMessage.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      service.handleAct(legacySession.id, {
        instruction: 'This must be durable before execution',
        dbSessionId: legacySession.id,
      }),
    ).rejects.toThrow('Failed to persist user message: database unavailable');

    expect(run).not.toHaveBeenCalled();
    expect(service.getRunningExecutions()).toHaveLength(0);
  });

  it.each(['delete', 'reset'] as const)(
    'waits for deferred preparation before a session %s mutation',
    async (operation) => {
      legacySession.engineName = 'claude';
      legacySession.engineSessionId = undefined;
      legacySession.model = undefined;
      const sessionLookup = deferred<AgentSession | undefined>();
      sessionServiceMocks.getSession.mockImplementationOnce(() => sessionLookup.promise);
      const run = vi.fn();
      const service = new AgentChatService({
        engines: [{ name: 'claude', supportsMcp: true, initializeAndRun: run }],
        streamManager: new AgentStreamManager(),
      });
      const actPromise = service.handleAct(legacySession.id, {
        instruction: 'Still preparing',
        dbSessionId: legacySession.id,
        requestId: `prepare-before-${operation}`,
      });
      const actExpectation = expect(actPromise).rejects.toThrow(
        'Execution cancelled during preparation',
      );
      const mutation = vi.fn().mockResolvedValue(operation);
      const lifecyclePromise = service.withSessionLifecycleMutation(legacySession.id, mutation);

      expect(mutation).not.toHaveBeenCalled();
      await expect(
        service.handleAct(legacySession.id, {
          instruction: 'Must be rejected by the tombstone',
          dbSessionId: legacySession.id,
          requestId: `blocked-during-${operation}`,
        }),
      ).rejects.toThrow('Session lifecycle mutation in progress');

      sessionLookup.resolve(legacySession);
      await actExpectation;
      await expect(lifecyclePromise).resolves.toBe(operation);
      expect(mutation).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
      expect(messageServiceMocks.createMessage).not.toHaveBeenCalled();
    },
  );

  it('waits for a deferred attachment save before deleting its project', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const savedAttachment = deferred<{
      absolutePath: string;
      filename: string;
      metadata: { filename: string };
    }>();
    attachmentServiceMocks.saveAttachment.mockImplementationOnce(() => savedAttachment.promise);
    const run = vi.fn();
    const service = new AgentChatService({
      engines: [{ name: 'claude', supportsMcp: true, initializeAndRun: run }],
      streamManager: new AgentStreamManager(),
    });
    const actPromise = service.handleAct(legacySession.id, {
      instruction: 'Prepare an image',
      projectId: legacySession.projectId,
      dbSessionId: legacySession.id,
      requestId: 'save-before-project-delete',
      attachments: [
        {
          type: 'image',
          name: 'deferred.png',
          mimeType: 'image/png',
          dataBase64: 'ZGVmZXJyZWQ=',
        },
      ],
    });
    const actExpectation = expect(actPromise).rejects.toThrow(
      'Failed to save attachments: Execution cancelled during preparation',
    );
    await vi.waitFor(() => expect(attachmentServiceMocks.saveAttachment).toHaveBeenCalledOnce());

    const mutation = vi.fn().mockResolvedValue('deleted');
    const deletePromise = service.withProjectLifecycleMutation(
      legacySession.projectId,
      async () => [legacySession.id],
      mutation,
    );
    expect(mutation).not.toHaveBeenCalled();
    await expect(
      service.handleAct(legacySession.id, {
        instruction: 'Must be rejected by the project tombstone',
        projectId: legacySession.projectId,
        dbSessionId: legacySession.id,
        requestId: 'blocked-during-project-delete',
      }),
    ).rejects.toThrow('Project lifecycle mutation in progress');

    savedAttachment.resolve({
      absolutePath: '/private/deferred.png',
      filename: 'deferred.png',
      metadata: { filename: 'deferred.png' },
    });
    await actExpectation;
    await expect(deletePromise).resolves.toBe('deleted');
    expect(attachmentServiceMocks.deleteAttachment).toHaveBeenCalledWith(
      legacySession.projectId,
      'deferred.png',
    );
    expect(mutation).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it('waits for deferred user-message persistence before resetting the session', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const persistence = deferred<void>();
    messageServiceMocks.createMessage.mockImplementationOnce(() => persistence.promise);
    const run = vi.fn();
    const service = new AgentChatService({
      engines: [{ name: 'claude', supportsMcp: true, initializeAndRun: run }],
      streamManager: new AgentStreamManager(),
    });
    const actPromise = service.handleAct(legacySession.id, {
      instruction: 'Persist before reset',
      dbSessionId: legacySession.id,
      requestId: 'persist-before-reset',
    });
    const actExpectation = expect(actPromise).rejects.toThrow(
      'Failed to persist user message: Execution cancelled during preparation',
    );
    await vi.waitFor(() => expect(messageServiceMocks.createMessage).toHaveBeenCalledOnce());

    const reset = vi.fn().mockResolvedValue('reset');
    const resetPromise = service.withSessionLifecycleMutation(legacySession.id, reset);
    expect(reset).not.toHaveBeenCalled();

    persistence.resolve();
    await actExpectation;
    await expect(resetPromise).resolves.toBe('reset');
    expect(reset).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it('waits for an aborted engine to settle before deleting the session', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const engineRelease = deferred<void>();
    let engineSignal: AbortSignal | undefined;
    const engine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options) {
        engineSignal = options.signal;
        await engineRelease.promise;
      },
    };
    const service = new AgentChatService({
      engines: [engine],
      streamManager: new AgentStreamManager(),
    });

    await service.handleAct(legacySession.id, {
      instruction: 'Keep the engine alive until cleanup',
      dbSessionId: legacySession.id,
      requestId: 'engine-before-delete',
    });
    await vi.waitFor(() => expect(engineSignal).toBeDefined());

    const deleteSession = vi.fn().mockResolvedValue('deleted');
    const deletePromise = service.withSessionLifecycleMutation(legacySession.id, deleteSession);
    expect(engineSignal?.aborted).toBe(true);
    expect(deleteSession).not.toHaveBeenCalled();

    engineRelease.resolve();
    await expect(deletePromise).resolves.toBe('deleted');
    expect(deleteSession).toHaveBeenCalledOnce();
    expect(service.getRunningExecutions()).toHaveLength(0);
  });

  it('drains late assistant persistence before session history is deleted', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const assistantPersistence = deferred<void>();
    const ordering: string[] = [];
    messageServiceMocks.createMessage
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        await assistantPersistence.promise;
        ordering.push('assistant persisted');
      });
    const engine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options, ctx) {
        ctx.emit({
          type: 'message',
          data: {
            id: 'late-assistant-persistence',
            sessionId: legacySession.id,
            role: 'assistant',
            content: 'Persist me before reset removes history',
            messageType: 'chat',
            cliSource: 'claude',
            requestId: 'late-persistence-request',
            isStreaming: false,
            isFinal: true,
            createdAt: new Date().toISOString(),
          },
        });
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) {
            resolve();
            return;
          }
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    const service = new AgentChatService({
      engines: [engine],
      streamManager: new AgentStreamManager(),
    });

    await service.handleAct(legacySession.id, {
      instruction: 'Generate a persisted reply',
      dbSessionId: legacySession.id,
      requestId: 'late-persistence-request',
    });
    await vi.waitFor(() => expect(messageServiceMocks.createMessage).toHaveBeenCalledTimes(2));

    const deleteHistory = vi.fn(async () => {
      ordering.push('history deleted');
      return 'deleted';
    });
    const resetPromise = service.withSessionLifecycleMutation(legacySession.id, deleteHistory);
    expect(deleteHistory).not.toHaveBeenCalled();

    assistantPersistence.resolve();
    await expect(resetPromise).resolves.toBe('deleted');
    expect(ordering).toEqual(['assistant persisted', 'history deleted']);
    expect(messageServiceMocks.createMessage).toHaveBeenCalledTimes(2);
    expect(service.getRunningExecutions()).toHaveLength(0);
  });
});
