import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEngine, EngineInitOptions } from './engines/types';
import { AgentStreamManager } from './stream-manager';
import type { AgentSession } from './session-service';

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
  },
}));

import { AgentChatService } from './chat-service';

describe('AgentChatService legacy session migration', () => {
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
  });

  afterEach(() => {
    vi.clearAllMocks();
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
});
