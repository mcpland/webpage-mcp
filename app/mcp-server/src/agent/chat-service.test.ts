import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEngine, EngineInitOptions } from './engines/types';
import { AgentStreamManager } from './stream-manager';
import type { AgentSession } from './session-service';
import type { RealtimeEvent } from './types';
import {
  AGENT_CLIENT_META_MAX_JSON_BYTES,
  AGENT_DISPLAY_TEXT_MAX_BYTES,
  AGENT_MESSAGE_CONTENT_MAX_BYTES,
  AGENT_STREAM_MAX_ERROR_BYTES,
  AGENT_STREAM_MAX_EVENTS_PER_REQUEST,
  AGENT_STREAM_MAX_JSON_BYTES_PER_REQUEST,
  AGENT_STREAM_MAX_STATUS_MESSAGE_BYTES,
} from 'webpage-mcp-shared';
import {
  AGENT_PAYLOAD_INVALID,
  AGENT_PAYLOAD_TOO_LARGE,
  getJsonByteLength,
} from './payload-limits';

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

import {
  AGENT_EXECUTION_LIMITS,
  AGENT_EXECUTION_OUTPUT_LIMIT_MESSAGE,
  AGENT_EXECUTION_OUTPUT_LIMITS,
  AgentChatService,
} from './chat-service';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function containsAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
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
  ])(
    'rejects $name before reserving or producing side effects',
    async ({ payload, code, field }) => {
      const run = vi.fn();
      const streamManager = new AgentStreamManager();
      const streamedEvents: unknown[] = [];
    streamManager.addListener(legacySession.id, (event) => streamedEvents.push(event));
    const service = new AgentChatService({
      engines: [{ name: 'claude', supportsMcp: true, initializeAndRun: run }],
        streamManager,
      });

      await expect(service.handleAct(legacySession.id, payload)).rejects.toMatchObject({
        code,
        field,
      });

      expect(service.getRunningExecutions()).toHaveLength(0);
      expect(sessionServiceMocks.getSession).not.toHaveBeenCalled();
    expect(projectServiceMocks.getProject).not.toHaveBeenCalled();
    expect(attachmentServiceMocks.saveAttachment).not.toHaveBeenCalled();
      expect(messageServiceMocks.createMessage).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(streamedEvents).toEqual([]);
    },
  );

  it('caps concurrent preparation for one runtime session', async () => {
    const projectGate = deferred<any>();
    projectServiceMocks.getProject.mockReturnValue(projectGate.promise);
    const run = vi.fn().mockResolvedValue(undefined);
    const service = new AgentChatService({
      engines: [{ name: 'claude', supportsMcp: true, initializeAndRun: run }],
      streamManager: new AgentStreamManager(),
    });
    const pending = Array.from({ length: AGENT_EXECUTION_LIMITS.maxPerSession }, (_, index) =>
      service.handleAct('shared-runtime-session', {
        instruction: 'wait for project',
        projectId: 'project-1',
        requestId: `session-cap-${index}`,
      }),
    );
    await vi.waitFor(() =>
      expect(projectServiceMocks.getProject).toHaveBeenCalledTimes(
        AGENT_EXECUTION_LIMITS.maxPerSession,
      ),
    );

    await expect(
      service.handleAct('shared-runtime-session', {
        instruction: 'one too many',
        projectId: 'project-1',
        requestId: 'session-cap-overflow',
      }),
    ).rejects.toThrow('session execution capacity');
    expect(run).not.toHaveBeenCalled();

    projectGate.resolve({
      id: 'project-1',
      rootPath: process.cwd(),
      preferredCli: 'claude',
    });
    await Promise.all(pending);
    await vi.waitFor(() => expect(service.getRunningExecutions()).toHaveLength(0));
  });

  it('caps concurrent preparation globally across independent scopes', async () => {
    const projectGate = deferred<any>();
    projectServiceMocks.getProject.mockReturnValue(projectGate.promise);
    const service = new AgentChatService({
      engines: [
        {
          name: 'claude',
          supportsMcp: true,
          initializeAndRun: vi.fn().mockResolvedValue(undefined),
        },
      ],
      streamManager: new AgentStreamManager(),
    });
    const pending = Array.from({ length: AGENT_EXECUTION_LIMITS.maxGlobal }, (_, index) =>
      service.handleAct(`runtime-${index}`, {
        instruction: 'wait globally',
        projectId: `project-${index}`,
        requestId: `global-cap-${index}`,
      }),
    );
    await vi.waitFor(() =>
      expect(projectServiceMocks.getProject).toHaveBeenCalledTimes(
        AGENT_EXECUTION_LIMITS.maxGlobal,
      ),
    );

    await expect(
      service.handleAct('runtime-overflow', {
        instruction: 'one too many',
        projectId: 'project-overflow',
        requestId: 'global-cap-overflow',
      }),
    ).rejects.toThrow('execution capacity reached');

    projectGate.resolve({
      id: 'project-any',
      rootPath: process.cwd(),
      preferredCli: 'claude',
    });
    await Promise.all(pending);
    await vi.waitFor(() => expect(service.getRunningExecutions()).toHaveLength(0));
  });

  it('rechecks project capacity after resolving database sessions', async () => {
    const projectGate = deferred<any>();
    projectServiceMocks.getProject.mockReturnValue(projectGate.promise);
    sessionServiceMocks.getSession.mockImplementation(async (sessionId: string) => ({
      id: sessionId,
      projectId: 'project-1',
      engineName: 'claude',
      name: sessionId,
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }));
    const service = new AgentChatService({
      engines: [
        {
          name: 'claude',
          supportsMcp: true,
          initializeAndRun: vi.fn().mockResolvedValue(undefined),
        },
      ],
      streamManager: new AgentStreamManager(),
    });
    const pending = Array.from({ length: AGENT_EXECUTION_LIMITS.maxPerProject }, (_, index) =>
      service.handleAct(`runtime-${index}`, {
        instruction: 'resolve project later',
        dbSessionId: `db-session-${index}`,
        requestId: `project-cap-${index}`,
      }),
    );
    await vi.waitFor(() =>
      expect(projectServiceMocks.getProject).toHaveBeenCalledTimes(
        AGENT_EXECUTION_LIMITS.maxPerProject,
      ),
    );

    await expect(
      service.handleAct('runtime-overflow', {
        instruction: 'one too many for project',
        dbSessionId: 'db-session-overflow',
        requestId: 'project-cap-overflow',
      }),
    ).rejects.toThrow('project execution capacity');

    projectGate.resolve({
      id: 'project-1',
      rootPath: process.cwd(),
      preferredCli: 'claude',
    });
    await Promise.all(pending);
    await vi.waitFor(() => expect(service.getRunningExecutions()).toHaveLength(0));
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

    expect(attachmentServiceMocks.deleteAttachment).toHaveBeenCalledWith('project-1', 'first.png');
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
      if (event.type === 'message' && event.data?.content)
        streamedMessages.push(event.data.content);
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

    expect(attachmentServiceMocks.deleteAttachment).toHaveBeenCalledWith('project-1', 'first.png');
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

  it('publishes an error instead of completed when final assistant persistence fails', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    messageServiceMocks.createMessage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('assistant database unavailable'));

    const engine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(_options, ctx) {
        ctx.emit({
          type: 'message',
          data: {
            id: 'final-assistant-persistence-failure',
            sessionId: legacySession.id,
            role: 'assistant',
            content: 'This reply must be durable before completion',
            messageType: 'chat',
            cliSource: 'claude',
            requestId: 'final-persistence-failure',
            isStreaming: false,
            isFinal: true,
            createdAt: new Date().toISOString(),
          },
        });
      },
    };
    const streamManager = new AgentStreamManager();
    const streamedEvents: RealtimeEvent[] = [];
    streamManager.addListener(legacySession.id, (event) => streamedEvents.push(event));
    const service = new AgentChatService({ engines: [engine], streamManager });

    await service.handleAct(legacySession.id, {
      instruction: 'Generate a durable reply',
      dbSessionId: legacySession.id,
      requestId: 'final-persistence-failure',
    });

    await vi.waitFor(() => expect(service.getRunningExecutions()).toHaveLength(0));
    expect(messageServiceMocks.createMessage).toHaveBeenCalledTimes(2);
    expect(
      streamedEvents.some((event) => event.type === 'status' && event.data.status === 'completed'),
    ).toBe(false);
    expect(streamedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'error',
          error: 'Failed to persist final assistant message: assistant database unavailable',
        }),
        expect.objectContaining({
          type: 'status',
          data: expect.objectContaining({
            status: 'error',
            requestId: 'final-persistence-failure',
          }),
        }),
      ]),
    );
  });

  it('publishes completed exactly once after final assistant persistence succeeds', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const finalPersistence = deferred<void>();
    messageServiceMocks.createMessage
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => finalPersistence.promise);

    const engine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(_options, ctx) {
        ctx.emit({
          type: 'message',
          data: {
            id: 'final-assistant-persistence-success',
            sessionId: legacySession.id,
            role: 'assistant',
            content: 'This reply becomes durable before completion',
            messageType: 'chat',
            cliSource: 'claude',
            requestId: 'final-persistence-success',
            isStreaming: false,
            isFinal: true,
            createdAt: new Date().toISOString(),
          },
        });
      },
    };
    const streamManager = new AgentStreamManager();
    const streamedEvents: RealtimeEvent[] = [];
    streamManager.addListener(legacySession.id, (event) => streamedEvents.push(event));
    const service = new AgentChatService({ engines: [engine], streamManager });

    await service.handleAct(legacySession.id, {
      instruction: 'Generate a durable reply',
      dbSessionId: legacySession.id,
      requestId: 'final-persistence-success',
    });
    await vi.waitFor(() => expect(messageServiceMocks.createMessage).toHaveBeenCalledTimes(2));

    expect(service.getRunningExecutions()).toHaveLength(1);
    expect(
      streamedEvents.some((event) => event.type === 'status' && event.data.status === 'completed'),
    ).toBe(false);

    finalPersistence.resolve();
    await vi.waitFor(() => expect(service.getRunningExecutions()).toHaveLength(0));
    expect(
      streamedEvents.filter(
        (event) => event.type === 'status' && event.data.status === 'completed',
      ),
    ).toHaveLength(1);
    expect(streamedEvents.some((event) => event.type === 'error')).toBe(false);
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
          options.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
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

  it('reserves relay headroom and emits one fixed terminal pair on event-count overflow', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const requestId = 'event-count-output-limit';
    let engineSignal: AbortSignal | undefined;
    const engine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options, ctx) {
        engineSignal = options.signal;
        const engineEventAllowance = AGENT_EXECUTION_OUTPUT_LIMITS.maxAdmittedEvents - 3;
        for (let index = 0; index < engineEventAllowance; index += 1) {
          ctx.emit({
            type: 'status',
            data: {
              sessionId: legacySession.id,
              requestId,
              status: 'ready',
            },
          });
        }
        ctx.emit({
          type: 'status',
          data: {
            sessionId: legacySession.id,
            requestId,
            status: 'ready',
            message: 'this overflowing engine event must not be relayed',
          },
        });
        ctx.emit({
          type: 'status',
          data: {
            sessionId: legacySession.id,
            requestId,
            status: 'completed',
            message: 'late forged completion',
          },
        });
      },
    };
    const streamManager = new AgentStreamManager();
    const streamedEvents: RealtimeEvent[] = [];
    streamManager.addListener(legacySession.id, (event) => streamedEvents.push(event));
    const service = new AgentChatService({ engines: [engine], streamManager });

    await service.handleAct(legacySession.id, {
      instruction: 'Exercise the event-count output limit',
      dbSessionId: legacySession.id,
      requestId,
    });
    await vi.waitFor(() =>
      expect(streamedEvents.filter((event) => event.type === 'error')).toHaveLength(1),
    );

    expect(engineSignal?.aborted).toBe(true);
    expect(streamedEvents).toHaveLength(AGENT_STREAM_MAX_EVENTS_PER_REQUEST);
    expect(
      streamedEvents.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'),
        0,
      ),
    ).toBeLessThanOrEqual(AGENT_STREAM_MAX_JSON_BYTES_PER_REQUEST);
    expect(
      streamedEvents.filter(
        (event) => event.type === 'error' && event.error === AGENT_EXECUTION_OUTPUT_LIMIT_MESSAGE,
      ),
    ).toHaveLength(1);
    expect(
      streamedEvents.filter(
        (event) =>
          event.type === 'status' &&
          event.data.status === 'error' &&
          event.data.message === AGENT_EXECUTION_OUTPUT_LIMIT_MESSAGE,
      ),
    ).toHaveLength(1);
    expect(
      streamedEvents.some((event) => event.type === 'status' && event.data.status === 'completed'),
    ).toBe(false);
    expect(
      streamedEvents.some(
        (event) =>
          event.type === 'status' &&
          event.data.message === 'this overflowing engine event must not be relayed',
      ),
    ).toBe(false);
    expect(messageServiceMocks.createMessage).toHaveBeenCalledTimes(1);
    expect(service.cancelExecution(legacySession.id, requestId)).toBe(false);
    await vi.waitFor(() => expect(service.getRunningExecutions()).toHaveLength(0));
  });

  it('measures aggregate event JSON in UTF-8 bytes and blocks the overflowing multibyte event', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const requestId = 'multibyte-output-limit';
    const multibyteContent = '界'.repeat(4_096);
    const attemptedEvent: RealtimeEvent = {
      type: 'message',
      data: {
        id: 'multibyte-stream-delta',
        sessionId: legacySession.id,
        role: 'assistant',
        content: multibyteContent,
        messageType: 'chat',
        cliSource: 'claude',
        requestId,
        isStreaming: true,
        isFinal: false,
        createdAt: new Date(0).toISOString(),
      },
    };
    let engineSignal: AbortSignal | undefined;
    const engine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options, ctx) {
        engineSignal = options.signal;
        for (let index = 0; index < AGENT_STREAM_MAX_EVENTS_PER_REQUEST; index += 1) {
          ctx.emit(attemptedEvent);
        }
      },
    };
    const streamManager = new AgentStreamManager();
    const streamedEvents: RealtimeEvent[] = [];
    streamManager.addListener(legacySession.id, (event) => streamedEvents.push(event));
    const service = new AgentChatService({ engines: [engine], streamManager });

    await service.handleAct(legacySession.id, {
      instruction: 'Exercise the aggregate UTF-8 output limit',
      dbSessionId: legacySession.id,
      requestId,
    });
    await vi.waitFor(() => expect(engineSignal?.aborted).toBe(true));

    const terminalEvents = streamedEvents.filter(
      (event) =>
        event.type === 'error' || (event.type === 'status' && event.data.status === 'error'),
    );
    const nonTerminalEvents = streamedEvents.filter((event) => !terminalEvents.includes(event));
    const nonTerminalBytes = nonTerminalEvents.reduce(
      (total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'),
      0,
    );
    const attemptedEventBytes = Buffer.byteLength(JSON.stringify(attemptedEvent), 'utf8');
    const admittedMultibyteEvents = streamedEvents.filter(
      (event) => event.type === 'message' && event.data.content === multibyteContent,
    );

    expect(Buffer.byteLength(multibyteContent, 'utf8')).toBe(multibyteContent.length * 3);
    expect(admittedMultibyteEvents.length).toBeGreaterThan(0);
    expect(nonTerminalEvents.length).toBeLessThan(AGENT_EXECUTION_OUTPUT_LIMITS.maxAdmittedEvents);
    expect(nonTerminalBytes).toBeLessThanOrEqual(
      AGENT_EXECUTION_OUTPUT_LIMITS.maxAdmittedEventJsonBytes,
    );
    expect(nonTerminalBytes + attemptedEventBytes).toBeGreaterThan(
      AGENT_EXECUTION_OUTPUT_LIMITS.maxAdmittedEventJsonBytes,
    );
    expect(terminalEvents).toHaveLength(2);
    expect(
      streamedEvents.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'),
        0,
      ),
    ).toBeLessThanOrEqual(AGENT_STREAM_MAX_JSON_BYTES_PER_REQUEST);
    expect(messageServiceMocks.createMessage).toHaveBeenCalledTimes(1);
  });

  it('admits persistence before publish/write and settles every admitted deferred write', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const requestId = 'pending-persistence-output-limit';
    const persistenceGates = Array.from(
      { length: AGENT_EXECUTION_OUTPUT_LIMITS.maxPendingPersistence },
      () => deferred<void>(),
    );
    let assistantWriteIndex = 0;
    messageServiceMocks.createMessage.mockImplementation((input: { role?: string }) => {
      if (input.role === 'user') return Promise.resolve(undefined);
      const gate = persistenceGates[assistantWriteIndex];
      assistantWriteIndex += 1;
      return gate?.promise ?? Promise.resolve(undefined);
    });
    let engineSignal: AbortSignal | undefined;
    const engine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options, ctx) {
        engineSignal = options.signal;
        for (
          let index = 0;
          index < AGENT_EXECUTION_OUTPUT_LIMITS.maxPendingPersistence + 1;
          index += 1
        ) {
          ctx.emit({
            type: 'message',
            data: {
              id: `deferred-assistant-${index}`,
              sessionId: legacySession.id,
              role: 'assistant',
              content: `deferred assistant ${index}`,
              messageType: 'chat',
              cliSource: 'claude',
              requestId,
              isStreaming: false,
              isFinal: true,
              createdAt: new Date(0).toISOString(),
            },
          });
        }
        ctx.emit({
          type: 'message',
          data: {
            id: 'late-after-persistence-limit',
            sessionId: legacySession.id,
            role: 'assistant',
            content: 'late after persistence limit',
            messageType: 'chat',
            cliSource: 'claude',
            requestId,
            isStreaming: false,
            isFinal: true,
            createdAt: new Date(0).toISOString(),
          },
        });
      },
    };
    const streamManager = new AgentStreamManager();
    const streamedEvents: RealtimeEvent[] = [];
    streamManager.addListener(legacySession.id, (event) => streamedEvents.push(event));
    const service = new AgentChatService({ engines: [engine], streamManager });

    await service.handleAct(legacySession.id, {
      instruction: 'Exercise pending persistence admission',
      dbSessionId: legacySession.id,
      requestId,
    });
    await vi.waitFor(() =>
      expect(messageServiceMocks.createMessage).toHaveBeenCalledTimes(
        1 + AGENT_EXECUTION_OUTPUT_LIMITS.maxPendingPersistence,
      ),
    );

    const assistantEvents = streamedEvents.filter(
      (event) => event.type === 'message' && event.data.role === 'assistant',
    );
    expect(engineSignal?.aborted).toBe(true);
    expect(assistantEvents).toHaveLength(AGENT_EXECUTION_OUTPUT_LIMITS.maxPendingPersistence);
    expect(
      assistantEvents.some((event) =>
        event.type === 'message' ? event.data.content === 'late after persistence limit' : false,
      ),
    ).toBe(false);
    expect(
      streamedEvents.filter(
        (event) => event.type === 'error' && event.error === AGENT_EXECUTION_OUTPUT_LIMIT_MESSAGE,
      ),
    ).toHaveLength(1);
    expect(
      streamedEvents.some((event) => event.type === 'status' && event.data.status === 'completed'),
    ).toBe(false);
    expect(service.cancelExecution(legacySession.id, requestId)).toBe(false);

    const mutation = vi.fn().mockResolvedValue('settled');
    const lifecyclePromise = service.withSessionLifecycleMutation(legacySession.id, mutation);
    await Promise.resolve();
    expect(mutation).not.toHaveBeenCalled();
    for (const gate of persistenceGates) gate.resolve();
    await expect(lifecyclePromise).resolves.toBe('settled');
    expect(mutation).toHaveBeenCalledOnce();
    expect(messageServiceMocks.createMessage).toHaveBeenCalledTimes(
      1 + AGENT_EXECUTION_OUTPUT_LIMITS.maxPendingPersistence,
    );
    expect(service.getRunningExecutions()).toHaveLength(0);
  });

  it('caps persisted message count even when writes settle between engine emissions', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const requestId = 'persisted-message-count-limit';
    let engineSignal: AbortSignal | undefined;
    const engine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options, ctx) {
        engineSignal = options.signal;
        for (
          let index = 0;
          index < AGENT_EXECUTION_OUTPUT_LIMITS.maxPersistedMessages;
          index += 1
        ) {
          ctx.emit({
            type: 'message',
            data: {
              id: `counted-assistant-${index}`,
              sessionId: legacySession.id,
              role: 'assistant',
              content: `counted assistant ${index}`,
              messageType: 'chat',
              cliSource: 'claude',
              requestId,
              isStreaming: false,
              isFinal: true,
              createdAt: new Date(0).toISOString(),
            },
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      },
    };
    const streamManager = new AgentStreamManager();
    const streamedEvents: RealtimeEvent[] = [];
    streamManager.addListener(legacySession.id, (event) => streamedEvents.push(event));
    const service = new AgentChatService({ engines: [engine], streamManager });

    await service.handleAct(legacySession.id, {
      instruction: 'Exercise persisted message count admission',
      dbSessionId: legacySession.id,
      requestId,
    });
    await vi.waitFor(() => expect(engineSignal?.aborted).toBe(true));
    await vi.waitFor(() => expect(service.getRunningExecutions()).toHaveLength(0));

    const persistedAssistantCalls = messageServiceMocks.createMessage.mock.calls.filter(
      ([input]) => (input as { role?: string }).role === 'assistant',
    );
    const streamedAssistantEvents = streamedEvents.filter(
      (event) => event.type === 'message' && event.data.role === 'assistant',
    );
    expect(persistedAssistantCalls).toHaveLength(
      AGENT_EXECUTION_OUTPUT_LIMITS.maxPersistedMessages - 1,
    );
    expect(streamedAssistantEvents).toHaveLength(
      AGENT_EXECUTION_OUTPUT_LIMITS.maxPersistedMessages - 1,
    );
    expect(
      streamedEvents.filter(
        (event) => event.type === 'error' && event.error === AGENT_EXECUTION_OUTPUT_LIMIT_MESSAGE,
      ),
    ).toHaveLength(1);
    expect(
      streamedEvents.some((event) => event.type === 'status' && event.data.status === 'completed'),
    ).toBe(false);
  });

  it('caps aggregate persisted JSON bytes independently and includes the user write', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const requestId = 'persisted-json-byte-limit';
    const largeContent = 'p'.repeat(188 * 1024);
    const attemptedAssistantMessages = 16;
    let engineSignal: AbortSignal | undefined;
    const engine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options, ctx) {
        engineSignal = options.signal;
        for (let index = 0; index < attemptedAssistantMessages; index += 1) {
          ctx.emit({
            type: 'message',
            data: {
              id: `aggregate-assistant-${index}`,
              sessionId: legacySession.id,
              role: 'assistant',
              content: largeContent,
              messageType: 'chat',
              cliSource: 'claude',
              requestId,
              isStreaming: false,
              isFinal: true,
              createdAt: new Date(0).toISOString(),
            },
          });
          // Keep pending persistence below its independent cap.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      },
    };
    const streamManager = new AgentStreamManager();
    const streamedEvents: RealtimeEvent[] = [];
    streamManager.addListener(legacySession.id, (event) => streamedEvents.push(event));
    const service = new AgentChatService({ engines: [engine], streamManager });

    await service.handleAct(legacySession.id, {
      instruction: 'Count the user write in persisted aggregate bytes',
      dbSessionId: legacySession.id,
      requestId,
    });
    await vi.waitFor(() => expect(engineSignal?.aborted).toBe(true));
    await vi.waitFor(() => expect(service.getRunningExecutions()).toHaveLength(0));

    const persistedInputs = messageServiceMocks.createMessage.mock.calls.map(
      ([input]) => input as Record<string, unknown>,
    );
    const persistedAssistantInputs = persistedInputs.filter(
      (input) => input.role === 'assistant',
    );
    const streamedAssistantEvents = streamedEvents.filter(
      (event) => event.type === 'message' && event.data.role === 'assistant',
    );
    const admittedPersistenceBytes = persistedInputs.reduce(
      (total, input) => total + getJsonByteLength(input),
      0,
    );
    const nextPersistenceBytes = getJsonByteLength(persistedAssistantInputs[0]);

    expect(persistedInputs[0].role).toBe('user');
    expect(persistedInputs).toHaveLength(persistedAssistantInputs.length + 1);
    expect(persistedAssistantInputs.length).toBeGreaterThan(0);
    expect(persistedAssistantInputs.length).toBeLessThan(attemptedAssistantMessages);
    expect(persistedInputs.length).toBeLessThan(
      AGENT_EXECUTION_OUTPUT_LIMITS.maxPersistedMessages,
    );
    expect(admittedPersistenceBytes).toBeLessThanOrEqual(
      AGENT_EXECUTION_OUTPUT_LIMITS.maxPersistedJsonBytes,
    );
    expect(admittedPersistenceBytes + nextPersistenceBytes).toBeGreaterThan(
      AGENT_EXECUTION_OUTPUT_LIMITS.maxPersistedJsonBytes,
    );
    expect(streamedAssistantEvents).toHaveLength(persistedAssistantInputs.length);
    expect(streamedEvents.length).toBeLessThan(
      AGENT_EXECUTION_OUTPUT_LIMITS.maxAdmittedEvents,
    );
    expect(
      streamedEvents.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'),
        0,
      ),
    ).toBeLessThan(AGENT_EXECUTION_OUTPUT_LIMITS.maxAdmittedEventJsonBytes);
    expect(
      streamedEvents.filter(
        (event) => event.type === 'error' && event.error === AGENT_EXECUTION_OUTPUT_LIMIT_MESSAGE,
      ),
    ).toHaveLength(1);
    expect(
      streamedEvents.some(
        (event) => event.type === 'status' && event.data.status === 'completed',
      ),
    ).toBe(false);
  });

  it('turns an unserializable engine event into one fixed terminal without attacker content', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const requestId = 'cyclic-engine-event';
    const attackerMarker = 'ATTACKER_EVENT_CONTENT_MUST_NOT_LEAK';
    const cyclicMetadata: Record<string, unknown> = { attackerMarker };
    cyclicMetadata.self = cyclicMetadata;
    let emitReturned = false;
    let engineSignal: AbortSignal | undefined;
    const engine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options, ctx) {
        engineSignal = options.signal;
        ctx.emit({
          type: 'message',
          data: {
            id: 'cyclic-engine-message',
            sessionId: legacySession.id,
            role: 'assistant',
            content: attackerMarker,
            messageType: 'chat',
            cliSource: 'claude',
            requestId,
            isStreaming: true,
            isFinal: false,
            createdAt: new Date(0).toISOString(),
            metadata: cyclicMetadata,
          },
        });
        emitReturned = true;
      },
    };
    const streamManager = new AgentStreamManager();
    const streamedEvents: RealtimeEvent[] = [];
    streamManager.addListener(legacySession.id, (event) => streamedEvents.push(event));
    const service = new AgentChatService({ engines: [engine], streamManager });

    await service.handleAct(legacySession.id, {
      instruction: 'Reject the cyclic engine event',
      dbSessionId: legacySession.id,
      requestId,
    });
    await vi.waitFor(() => expect(service.getRunningExecutions()).toHaveLength(0));

    expect(emitReturned).toBe(true);
    expect(engineSignal?.aborted).toBe(true);
    expect(messageServiceMocks.createMessage).toHaveBeenCalledTimes(1);
    expect(
      streamedEvents.filter(
        (event) => event.type === 'error' && event.error === AGENT_EXECUTION_OUTPUT_LIMIT_MESSAGE,
      ),
    ).toHaveLength(1);
    expect(
      streamedEvents.filter(
        (event) => event.type === 'status' && event.data.status === 'error',
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(streamedEvents)).not.toContain(attackerMarker);
    expect(
      streamedEvents.some(
        (event) => event.type === 'status' && event.data.status === 'completed',
      ),
    ).toBe(false);
  });

  it('bounds and sanitizes a huge normal engine error before terminal publication', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const requestId = 'huge-engine-error';
    const hugeMessage = `${'\u0000\u001f'.repeat(32)}${'界'.repeat(10_000)}`;
    const engine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun() {
        throw new Error(hugeMessage);
      },
    };
    const streamManager = new AgentStreamManager();
    const streamedEvents: RealtimeEvent[] = [];
    streamManager.addListener(legacySession.id, (event) => streamedEvents.push(event));
    const service = new AgentChatService({ engines: [engine], streamManager });

    await service.handleAct(legacySession.id, {
      instruction: 'Throw one bounded terminal error',
      dbSessionId: legacySession.id,
      requestId,
    });
    await vi.waitFor(() => expect(service.getRunningExecutions()).toHaveLength(0));

    const errors = streamedEvents.filter(
      (event): event is Extract<RealtimeEvent, { type: 'error' }> => event.type === 'error',
    );
    const errorStatuses = streamedEvents.filter(
      (event): event is Extract<RealtimeEvent, { type: 'status' }> =>
        event.type === 'status' && event.data.status === 'error',
    );
    expect(errors).toHaveLength(1);
    expect(errorStatuses).toHaveLength(1);
    expect(Buffer.byteLength(errors[0].error, 'utf8')).toBeLessThanOrEqual(
      AGENT_STREAM_MAX_ERROR_BYTES,
    );
    expect(Buffer.byteLength(errorStatuses[0].data.message ?? '', 'utf8')).toBeLessThanOrEqual(
      AGENT_STREAM_MAX_STATUS_MESSAGE_BYTES,
    );
    expect(containsAsciiControl(errors[0].error)).toBe(false);
    expect(containsAsciiControl(errorStatuses[0].data.message ?? '')).toBe(false);
    expect(
      streamedEvents.some((event) => event.type === 'status' && event.data.status === 'completed'),
    ).toBe(false);
    expect(
      streamedEvents.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'),
        0,
      ),
    ).toBeLessThanOrEqual(AGENT_STREAM_MAX_JSON_BYTES_PER_REQUEST);
  });

  it('keeps the reserved completed terminal reachable at the exact admission boundary', async () => {
    legacySession.engineName = 'claude';
    legacySession.engineSessionId = undefined;
    legacySession.model = undefined;
    const requestId = 'completed-at-output-boundary';
    let engineSignal: AbortSignal | undefined;
    const engine: AgentEngine = {
      name: 'claude',
      supportsMcp: true,
      async initializeAndRun(options, ctx) {
        engineSignal = options.signal;
        const engineEventAllowance = AGENT_EXECUTION_OUTPUT_LIMITS.maxAdmittedEvents - 3;
        for (let index = 0; index < engineEventAllowance; index += 1) {
          ctx.emit({
            type: 'status',
            data: {
              sessionId: legacySession.id,
              requestId,
              status: 'ready',
            },
          });
        }
      },
    };
    const streamManager = new AgentStreamManager();
    const streamedEvents: RealtimeEvent[] = [];
    streamManager.addListener(legacySession.id, (event) => streamedEvents.push(event));
    const service = new AgentChatService({ engines: [engine], streamManager });

    await service.handleAct(legacySession.id, {
      instruction: 'Complete at the output boundary',
      dbSessionId: legacySession.id,
      requestId,
    });
    await vi.waitFor(() => expect(service.getRunningExecutions()).toHaveLength(0));

    expect(engineSignal?.aborted).toBe(false);
    expect(streamedEvents).toHaveLength(AGENT_EXECUTION_OUTPUT_LIMITS.maxAdmittedEvents + 1);
    expect(
      streamedEvents.filter(
        (event) => event.type === 'status' && event.data.status === 'completed',
      ),
    ).toHaveLength(1);
    expect(streamedEvents.some((event) => event.type === 'error')).toBe(false);
    expect(streamedEvents.length).toBeLessThanOrEqual(AGENT_STREAM_MAX_EVENTS_PER_REQUEST);
    expect(
      streamedEvents.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'),
        0,
      ),
    ).toBeLessThanOrEqual(AGENT_STREAM_MAX_JSON_BYTES_PER_REQUEST);
  });
});
