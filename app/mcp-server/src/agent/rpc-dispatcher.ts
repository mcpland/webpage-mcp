import { HTTP_STATUS, ERROR_MESSAGES } from '../constant';
import type { AgentChatService } from './chat-service';
import type { AgentActRequest, AgentActResponse } from './types';
import type { CreateOrUpdateProjectInput } from './project-types';
import {
  createProjectDirectory,
  deleteProject,
  listProjects,
  upsertProject,
  validateRootPath,
} from './project-service';
import {
  createMessage as createStoredMessage,
  deleteMessagesByProjectId,
  deleteMessagesBySessionId,
  getMessagesByProjectId,
  getMessagesCountByProjectId,
  getMessagesBySessionId,
  getMessagesCountBySessionId,
} from './message-service';
import {
  createSession,
  deleteSession,
  getSession,
  getSessionsByProject,
  getSessionsByProjectAndEngine,
  getAllSessions,
  updateSession,
  type CreateSessionOptions,
  type UpdateSessionInput,
} from './session-service';
import { getProject } from './project-service';
import { getDefaultWorkspaceDir, getDefaultProjectRoot } from './storage';
import { openDirectoryPicker } from './directory-picker';
import type { EngineName } from './engines/types';
import { attachmentService } from './attachment-service';
import { openProjectDirectory, openFileInVSCode } from './open-project';
import type {
  AgentRpcRequestPayload,
  AttachmentCleanupRequest,
  AttachmentCleanupResponse,
  AttachmentStatsResponse,
  OpenProjectTarget,
} from 'webpage-mcp-shared';

const VALID_OPEN_TARGETS: readonly OpenProjectTarget[] = ['vscode', 'terminal'];

function getRegisteredEngineNames(chatService: AgentChatService): EngineName[] {
  return chatService.getEngineInfos().map((engine) => engine.name);
}

function isValidEngineName(name: string, validEngineNames: readonly EngineName[]): name is EngineName {
  return validEngineNames.includes(name as EngineName);
}

function isValidOpenTarget(target: string): target is OpenProjectTarget {
  return VALID_OPEN_TARGETS.includes(target as OpenProjectTarget);
}

export interface RpcDispatchResponse {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  json: unknown;
  isBinary: boolean;
  base64Body: string | null;
}

export interface RpcDispatchDependencies {
  chatService: AgentChatService;
  requestExtension?: (payload: Record<string, unknown> | undefined) => Promise<unknown>;
}

function jsonResponse(statusCode: number, payload: unknown): RpcDispatchResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
    json: payload,
    isBinary: false,
    base64Body: null,
  };
}

function noContentResponse(): RpcDispatchResponse {
  return {
    statusCode: HTTP_STATUS.NO_CONTENT,
    headers: {},
    body: '',
    json: null,
    isBinary: false,
    base64Body: null,
  };
}

function binaryResponse(buffer: Buffer, contentType: string): RpcDispatchResponse {
  return {
    statusCode: HTTP_STATUS.OK,
    headers: {
      'content-type': contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    },
    body: '',
    json: null,
    isBinary: true,
    base64Body: buffer.toString('base64'),
  };
}

function normalizeBody(rawBody: unknown): unknown {
  if (rawBody === undefined || rawBody === null) {
    return undefined;
  }
  if (typeof rawBody === 'string') {
    const trimmed = rawBody.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return rawBody;
    }
  }
  return rawBody;
}

function bodyAsRecord(rawBody: unknown): Record<string, unknown> {
  const parsed = normalizeBody(rawBody);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const asString = readString(value);
  if (!asString) {
    return undefined;
  }
  const parsed = Number(asString);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readQueryValue(query: Record<string, unknown> | undefined, key: string): unknown {
  if (!query) {
    return undefined;
  }
  const raw = query[key];
  if (Array.isArray(raw)) {
    return raw.length > 0 ? raw[0] : undefined;
  }
  return raw;
}

function readParam(params: Record<string, unknown> | undefined, key: string): string {
  const value = readString(params?.[key]);
  return value?.trim() || '';
}

function toCreateOrUpdateProjectInput(
  payload: Record<string, unknown>,
): CreateOrUpdateProjectInput | null {
  const name = readString(payload.name)?.trim();
  const rootPath = readString(payload.rootPath)?.trim();
  if (!name || !rootPath) {
    return null;
  }
  return {
    id: readString(payload.id)?.trim(),
    name,
    description: readString(payload.description)?.trim(),
    rootPath,
    preferredCli: readString(payload.preferredCli) as CreateOrUpdateProjectInput['preferredCli'],
    selectedModel: readString(payload.selectedModel)?.trim(),
    enableWebpageMcp:
      typeof payload.enableWebpageMcp === 'boolean' ? payload.enableWebpageMcp : undefined,
    allowCreate: typeof payload.allowCreate === 'boolean' ? payload.allowCreate : undefined,
  };
}

function readOpenTargetFromBody(payload: Record<string, unknown>): string | undefined {
  return readString(payload.target)?.trim();
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function dispatchAgentRpc(
  request: AgentRpcRequestPayload,
  deps: RpcDispatchDependencies,
): Promise<RpcDispatchResponse> {
  const operation = request.operation?.trim();
  const params = request.params;
  const query = request.query;
  const body = request.body;

  if (!operation) {
    return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'operation is required' });
  }

  try {
    switch (operation) {
      case 'health.ping': {
        return jsonResponse(HTTP_STATUS.OK, { status: 'ok', message: 'pong' });
      }

      case 'extension.ask': {
        if (!deps.requestExtension) {
          return jsonResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE,
          });
        }
        const payload = query && typeof query === 'object' ? (query as Record<string, unknown>) : undefined;
        const extensionResponse = await deps.requestExtension(payload);
        return jsonResponse(HTTP_STATUS.OK, { status: 'success', data: extensionResponse });
      }

      case 'agent.engines.list': {
        const engines = deps.chatService.getEngineInfos();
        return jsonResponse(HTTP_STATUS.OK, { engines });
      }

      case 'agent.projects.list': {
        const projects = await listProjects();
        return jsonResponse(HTTP_STATUS.OK, { projects });
      }

      case 'agent.projects.upsert': {
        const validEngineNames = getRegisteredEngineNames(deps.chatService);
        const rawPayload = bodyAsRecord(body);
        const payload = toCreateOrUpdateProjectInput(rawPayload);
        if (!payload) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            error: 'name and rootPath are required to create a project',
          });
        }
        if (payload.preferredCli && !isValidEngineName(payload.preferredCli, validEngineNames)) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            error: `Invalid preferredCli. Must be one of: ${validEngineNames.join(', ')}`,
          });
        }
        const project = await upsertProject(payload);
        return jsonResponse(HTTP_STATUS.OK, { project });
      }

      case 'agent.projects.delete': {
        const projectId = readParam(params, 'projectId');
        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'project id is required' });
        }
        await deleteProject(projectId);
        return noContentResponse();
      }

      case 'agent.projects.validatePath': {
        const payload = bodyAsRecord(body);
        const rootPath = readString(payload.rootPath);
        if (!rootPath) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'rootPath is required' });
        }
        const result = await validateRootPath(rootPath);
        return jsonResponse(HTTP_STATUS.OK, result);
      }

      case 'agent.projects.createDirectory': {
        const payload = bodyAsRecord(body);
        const absolutePath = readString(payload.absolutePath);
        if (!absolutePath) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'absolutePath is required' });
        }
        try {
          await createProjectDirectory(absolutePath);
          return jsonResponse(HTTP_STATUS.OK, { success: true, path: absolutePath });
        } catch (error) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: normalizeError(error) });
        }
      }

      case 'agent.projects.defaultWorkspace': {
        const workspaceDir = getDefaultWorkspaceDir();
        return jsonResponse(HTTP_STATUS.OK, { success: true, path: workspaceDir });
      }

      case 'agent.projects.defaultRoot': {
        const payload = bodyAsRecord(body);
        const projectName = readString(payload.projectName);
        if (!projectName) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'projectName is required' });
        }
        const rootPath = getDefaultProjectRoot(projectName);
        return jsonResponse(HTTP_STATUS.OK, { success: true, path: rootPath });
      }

      case 'agent.projects.pickDirectory': {
        const result = await openDirectoryPicker('Select Project Directory');
        if (result.success && result.path) {
          return jsonResponse(HTTP_STATUS.OK, { success: true, path: result.path });
        }
        if (result.cancelled) {
          return jsonResponse(HTTP_STATUS.OK, { success: false, cancelled: true });
        }
        return jsonResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, {
          success: false,
          error: result.error || 'Failed to open directory picker',
        });
      }

      case 'agent.sessions.list': {
        const sessions = await getAllSessions();
        return jsonResponse(HTTP_STATUS.OK, { sessions });
      }

      case 'agent.projects.sessions.list': {
        const projectId = readParam(params, 'projectId');
        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'projectId is required' });
        }
        const sessions = await getSessionsByProject(projectId);
        return jsonResponse(HTTP_STATUS.OK, { sessions });
      }

      case 'agent.projects.sessions.create': {
        const validEngineNames = getRegisteredEngineNames(deps.chatService);
        const projectId = readParam(params, 'projectId');
        const payload = bodyAsRecord(body) as CreateSessionOptions & { engineName?: string };

        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'projectId is required' });
        }
        if (!payload.engineName) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'engineName is required' });
        }
        if (!isValidEngineName(payload.engineName, validEngineNames)) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            error: `Invalid engineName. Must be one of: ${validEngineNames.join(', ')}`,
          });
        }

        const project = await getProject(projectId);
        if (!project) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Project not found' });
        }

        const session = await createSession(projectId, payload.engineName, {
          name: payload.name,
          model: payload.model,
          permissionMode: payload.permissionMode,
          allowDangerouslySkipPermissions: payload.allowDangerouslySkipPermissions,
          systemPromptConfig: payload.systemPromptConfig,
          optionsConfig: payload.optionsConfig,
        });

        return jsonResponse(HTTP_STATUS.CREATED, { session });
      }

      case 'agent.sessions.get': {
        const sessionId = readParam(params, 'sessionId');
        if (!sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'sessionId is required' });
        }
        const session = await getSession(sessionId);
        if (!session) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Session not found' });
        }
        return jsonResponse(HTTP_STATUS.OK, { session });
      }

      case 'agent.sessions.update': {
        const sessionId = readParam(params, 'sessionId');
        const updates = bodyAsRecord(body) as UpdateSessionInput;

        if (!sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'sessionId is required' });
        }

        const existing = await getSession(sessionId);
        if (!existing) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Session not found' });
        }

        await updateSession(sessionId, updates);
        const updated = await getSession(sessionId);
        return jsonResponse(HTTP_STATUS.OK, { session: updated });
      }

      case 'agent.sessions.delete': {
        const sessionId = readParam(params, 'sessionId');
        if (!sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'sessionId is required' });
        }
        await deleteSession(sessionId);
        return noContentResponse();
      }

      case 'agent.sessions.history': {
        const sessionId = readParam(params, 'sessionId');
        if (!sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'sessionId is required' });
        }

        const limit = readNumber(readQueryValue(query, 'limit'));
        const offset = readNumber(readQueryValue(query, 'offset'));
        const safeLimit = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 0;
        const safeOffset = typeof offset === 'number' && offset >= 0 ? Math.floor(offset) : 0;

        const session = await getSession(sessionId);
        if (!session) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Session not found' });
        }

        const [messages, totalCount] = await Promise.all([
          getMessagesBySessionId(sessionId, safeLimit, safeOffset),
          getMessagesCountBySessionId(sessionId),
        ]);

        return jsonResponse(HTTP_STATUS.OK, {
          success: true,
          sessionId,
          messages,
          totalCount,
          pagination: {
            limit: safeLimit,
            offset: safeOffset,
            count: messages.length,
            hasMore: safeLimit > 0 ? safeOffset + messages.length < totalCount : false,
          },
        });
      }

      case 'agent.sessions.reset': {
        const sessionId = readParam(params, 'sessionId');
        if (!sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'sessionId is required' });
        }

        const existing = await getSession(sessionId);
        if (!existing) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Session not found' });
        }

        await updateSession(sessionId, { engineSessionId: null });
        const deletedMessages = await deleteMessagesBySessionId(sessionId);
        const updated = await getSession(sessionId);

        return jsonResponse(HTTP_STATUS.OK, {
          success: true,
          sessionId,
          deletedMessages,
          clearedEngineSessionId: Boolean(existing.engineSessionId),
          session: updated || null,
        });
      }

      case 'agent.sessions.claudeInfo': {
        const sessionId = readParam(params, 'sessionId');
        if (!sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'sessionId is required' });
        }

        const session = await getSession(sessionId);
        if (!session) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Session not found' });
        }

        return jsonResponse(HTTP_STATUS.OK, {
          managementInfo: session.managementInfo || null,
          sessionId,
          engineName: session.engineName,
        });
      }

      case 'agent.projects.claudeInfo': {
        const projectId = readParam(params, 'projectId');
        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'projectId is required' });
        }

        const project = await getProject(projectId);
        if (!project) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Project not found' });
        }

        const claudeSessions = await getSessionsByProjectAndEngine(projectId, 'claude');
        const sessionsWithInfo = claudeSessions.filter((s) => s.managementInfo);
        sessionsWithInfo.sort((a, b) => {
          const aTime = a.managementInfo?.lastUpdated || a.updatedAt || '';
          const bTime = b.managementInfo?.lastUpdated || b.updatedAt || '';
          return bTime.localeCompare(aTime);
        });

        const latestInfo = sessionsWithInfo[0]?.managementInfo || null;
        const sourceSessionId = sessionsWithInfo[0]?.id;

        return jsonResponse(HTTP_STATUS.OK, {
          managementInfo: latestInfo,
          sourceSessionId,
          projectId,
          sessionsWithInfo: sessionsWithInfo.length,
        });
      }

      case 'agent.sessions.open': {
        const sessionId = readParam(params, 'sessionId');
        const payload = bodyAsRecord(body);
        const target = readOpenTargetFromBody(payload);

        if (!sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { success: false, error: 'sessionId is required' });
        }
        if (!target) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { success: false, error: 'target is required' });
        }
        if (!isValidOpenTarget(target)) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            success: false,
            error: `Invalid target. Must be one of: ${VALID_OPEN_TARGETS.join(', ')}`,
          });
        }

        const session = await getSession(sessionId);
        if (!session) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { success: false, error: 'Session not found' });
        }

        const project = await getProject(session.projectId);
        if (!project) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { success: false, error: 'Project not found' });
        }

        const result = await openProjectDirectory(project.rootPath, target);
        if (result.success) {
          return jsonResponse(HTTP_STATUS.OK, { success: true });
        }
        return jsonResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, {
          success: false,
          error: result.error,
        });
      }

      case 'agent.projects.open': {
        const projectId = readParam(params, 'projectId');
        const payload = bodyAsRecord(body);
        const target = readOpenTargetFromBody(payload);

        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { success: false, error: 'projectId is required' });
        }
        if (!target) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { success: false, error: 'target is required' });
        }
        if (!isValidOpenTarget(target)) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            success: false,
            error: `Invalid target. Must be one of: ${VALID_OPEN_TARGETS.join(', ')}`,
          });
        }

        const project = await getProject(projectId);
        if (!project) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { success: false, error: 'Project not found' });
        }

        const result = await openProjectDirectory(project.rootPath, target);
        if (result.success) {
          return jsonResponse(HTTP_STATUS.OK, { success: true });
        }
        return jsonResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, {
          success: false,
          error: result.error,
        });
      }

      case 'agent.projects.openFile': {
        const projectId = readParam(params, 'projectId');
        const payload = bodyAsRecord(body);
        const filePath = readString(payload.filePath);
        const line = readNumber(payload.line);
        const column = readNumber(payload.column);

        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { success: false, error: 'projectId is required' });
        }
        if (!filePath) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { success: false, error: 'filePath is required' });
        }

        const project = await getProject(projectId);
        if (!project) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { success: false, error: 'Project not found' });
        }

        const result = await openFileInVSCode(project.rootPath, filePath, line, column);
        if (result.success) {
          return jsonResponse(HTTP_STATUS.OK, { success: true });
        }
        return jsonResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, {
          success: false,
          error: result.error,
        });
      }

      case 'agent.chat.messages.list': {
        const projectId = readParam(params, 'projectId');
        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'projectId is required' });
        }

        const limit = readNumber(readQueryValue(query, 'limit'));
        const offset = readNumber(readQueryValue(query, 'offset'));
        const safeLimit = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : 50;
        const safeOffset = typeof offset === 'number' && offset >= 0 ? Math.floor(offset) : 0;

        const [messages, totalCount] = await Promise.all([
          getMessagesByProjectId(projectId, safeLimit, safeOffset),
          getMessagesCountByProjectId(projectId),
        ]);

        return jsonResponse(HTTP_STATUS.OK, {
          success: true,
          data: messages,
          totalCount,
          pagination: {
            limit: safeLimit,
            offset: safeOffset,
            count: messages.length,
            hasMore: safeOffset + messages.length < totalCount,
          },
        });
      }

      case 'agent.chat.messages.create': {
        const projectId = readParam(params, 'projectId');
        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'projectId is required' });
        }

        const payload = bodyAsRecord(body);
        const content = (readString(payload.content) || '').trim();
        if (!content) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            success: false,
            error: 'content is required',
          });
        }

        const rawRole = (readString(payload.role) || 'user').toLowerCase().trim();
        const role: 'assistant' | 'user' | 'system' | 'tool' =
          rawRole === 'assistant' || rawRole === 'system' || rawRole === 'tool' ? rawRole : 'user';

        const rawType = (readString(payload.messageType) || '').toLowerCase();
        const allowedTypes = ['chat', 'tool_use', 'tool_result', 'status'] as const;
        const fallbackType: (typeof allowedTypes)[number] = role === 'system' ? 'status' : 'chat';
        const messageType =
          (allowedTypes as readonly string[]).includes(rawType) && rawType
            ? (rawType as (typeof allowedTypes)[number])
            : fallbackType;

        const metadata =
          payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
            ? (payload.metadata as Record<string, unknown>)
            : undefined;
        const customId = readString(payload.id)?.trim();
        const targetSessionId = readString(payload.sessionId)?.trim();
        if (customId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            success: false,
            error: 'id is not allowed for agent.chat.messages.create',
          });
        }
        if (targetSessionId) {
          const session = await getSession(targetSessionId);
          if (!session) {
            return jsonResponse(HTTP_STATUS.NOT_FOUND, {
              success: false,
              error: 'Session not found',
            });
          }
          if (session.projectId !== projectId) {
            return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
              success: false,
              error: 'sessionId must belong to the target project',
            });
          }
        }

        const stored = await createStoredMessage({
          projectId,
          role,
          messageType,
          content,
          metadata,
          sessionId: targetSessionId,
          conversationId: readString(payload.conversationId),
          cliSource: readString(payload.cliSource),
          requestId: readString(payload.requestId),
          createdAt: readString(payload.createdAt),
        });

        return jsonResponse(HTTP_STATUS.CREATED, { success: true, data: stored });
      }

      case 'agent.chat.messages.delete': {
        const projectId = readParam(params, 'projectId');
        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'projectId is required' });
        }

        const conversationId = readString(readQueryValue(query, 'conversationId'));
        const deleted = await deleteMessagesByProjectId(projectId, conversationId || undefined);
        return jsonResponse(HTTP_STATUS.OK, { success: true, deleted });
      }

      case 'agent.chat.act': {
        const sessionId = readParam(params, 'sessionId');
        if (!sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            error: 'sessionId is required for agent act',
          });
        }

        const payload = normalizeBody(body);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            error: 'Invalid act payload',
          });
        }

        const { requestId } = await deps.chatService.handleAct(sessionId, payload as AgentActRequest);
        const response: AgentActResponse = {
          requestId,
          sessionId,
          status: 'accepted',
        };
        return jsonResponse(HTTP_STATUS.OK, response);
      }

      case 'agent.chat.cancelRequest': {
        const sessionId = readParam(params, 'sessionId');
        const requestId = readParam(params, 'requestId');
        if (!sessionId || !requestId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            error: 'sessionId and requestId are required',
          });
        }

        const cancelled = deps.chatService.cancelExecution(requestId);
        if (cancelled) {
          return jsonResponse(HTTP_STATUS.OK, {
            success: true,
            message: 'Execution cancelled',
            requestId,
            sessionId,
          });
        }

        return jsonResponse(HTTP_STATUS.OK, {
          success: false,
          message: 'No running execution found with this requestId',
          requestId,
          sessionId,
        });
      }

      case 'agent.chat.cancelCurrent': {
        const sessionId = readParam(params, 'sessionId');
        if (!sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'sessionId is required' });
        }

        const cancelledCount = deps.chatService.cancelSessionExecutions(sessionId);
        return jsonResponse(HTTP_STATUS.OK, {
          success: true,
          cancelledCount,
          sessionId,
        });
      }

      case 'agent.chat.stream': {
        return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
          error: 'Use agent_stream_subscribe over native messaging instead of chat.stream',
        });
      }

      case 'agent.attachments.stats': {
        const stats = await attachmentService.getAttachmentStats();
        const projects = await listProjects();
        const projectMap = new Map(projects.map((p) => [p.id, p.name]));
        const dbProjectIds = new Set(projects.map((p) => p.id));

        const enrichedProjects = stats.projects.map((p) => ({
          ...p,
          projectName: projectMap.get(p.projectId),
          existsInDb: dbProjectIds.has(p.projectId),
        }));

        const orphanProjectIds = stats.projects
          .filter((p) => !dbProjectIds.has(p.projectId))
          .map((p) => p.projectId);

        const response: AttachmentStatsResponse = {
          success: true,
          rootDir: stats.rootDir,
          totalFiles: stats.totalFiles,
          totalBytes: stats.totalBytes,
          projects: enrichedProjects,
          orphanProjectIds,
        };

        return jsonResponse(HTTP_STATUS.OK, response);
      }

      case 'agent.attachments.get': {
        const projectId = readParam(params, 'projectId');
        const filename = readParam(params, 'filename');

        try {
          const project = await getProject(projectId);
          if (!project) {
            return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Project not found' });
          }

          const buffer = await attachmentService.readAttachment(projectId, filename);

          const ext = filename.split('.').pop()?.toLowerCase();
          let contentType = 'application/octet-stream';
          switch (ext) {
            case 'png':
              contentType = 'image/png';
              break;
            case 'jpg':
            case 'jpeg':
              contentType = 'image/jpeg';
              break;
            case 'gif':
              contentType = 'image/gif';
              break;
            case 'webp':
              contentType = 'image/webp';
              break;
            default:
              break;
          }

          return binaryResponse(buffer, contentType);
        } catch (error) {
          const message = normalizeError(error);
          if (message.includes('Invalid') || message.includes('traversal')) {
            return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: message });
          }
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Attachment not found' });
        }
      }

      case 'agent.attachments.deleteByProject': {
        const projectId = readParam(params, 'projectId');
        const result = await attachmentService.cleanupAttachments({ projectIds: [projectId] });

        const response: AttachmentCleanupResponse = {
          success: true,
          scope: 'project',
          removedFiles: result.removedFiles,
          removedBytes: result.removedBytes,
          results: result.results,
        };

        return jsonResponse(HTTP_STATUS.OK, response);
      }

      case 'agent.attachments.deleteAll': {
        const payload = bodyAsRecord(body) as AttachmentCleanupRequest;
        const projectIds = Array.isArray(payload.projectIds) ? payload.projectIds : undefined;

        const result = await attachmentService.cleanupAttachments(
          projectIds ? { projectIds } : undefined,
        );

        const response: AttachmentCleanupResponse = {
          success: true,
          scope: projectIds && projectIds.length > 0 ? 'selected' : 'all',
          removedFiles: result.removedFiles,
          removedBytes: result.removedBytes,
          results: result.results,
        };

        return jsonResponse(HTTP_STATUS.OK, response);
      }

      default:
        return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
          error: `Unsupported RPC operation: ${operation}`,
        });
    }
  } catch (error) {
    return jsonResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, {
      error: normalizeError(error) || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
}
