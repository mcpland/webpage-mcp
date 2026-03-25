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
    saveAttachment: vi.fn(),
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

  beforeEach(() => {
    vi.clearAllMocks();
    legacySession.engineName = 'cursor';
    legacySession.engineSessionId = 'cursor-session-123';
    legacySession.model = 'cursor-proprietary-model';

    projectServiceMocks.getProject.mockResolvedValue({
      id: 'project-1',
      name: 'Project',
      rootPath: process.cwd(),
      preferredCli: 'claude',
      createdAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
      updatedAt: new Date('2026-03-25T00:00:00.000Z').toISOString(),
    });
    projectServiceMocks.touchProjectActivity.mockResolvedValue(undefined);
    projectServiceMocks.updateProjectClaudeSessionId.mockResolvedValue(undefined);
    messageServiceMocks.createMessage.mockResolvedValue(undefined);
    sessionServiceMocks.getSession.mockResolvedValue(legacySession);
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
});
