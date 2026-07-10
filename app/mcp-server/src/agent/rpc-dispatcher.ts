import { HTTP_STATUS, ERROR_MESSAGES } from '../constant';
import type { AgentChatService } from './chat-service';
import type { AgentActRequest, AgentActResponse } from './types';
import type { CreateOrUpdateProjectInput } from './project-types';
import {
  createProjectDirectory,
  deleteProject,
  getProjectsCount,
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
  getAllSessionsCount,
  getSessionsByProject,
  getSessionsCountByProject,
  getSessionsByProjectAndEngine,
  getAllSessions,
  updateSession,
  type CreateSessionOptions,
  type UpdateSessionInput,
} from './session-service';
import {
  sanitizeManagementInfoForPublicRead,
  sanitizeSessionForPublicRead,
} from './public-session-sanitizer';
import { validateAgentAttachments } from './attachment-limits';
import { validateSessionSecurityConfig } from './session-security';
import {
  validateSessionCreatePayload,
  validateSessionUpdatePayload,
} from './session-payload-limits';
import {
  validateProjectIdentifier,
  validateProjectName,
  validateProjectOpenFilePayload,
  validateProjectOpenTarget,
  validateProjectPath,
  validateProjectUpsertPayload,
} from './project-payload-limits';
import { sanitizeProjectForPublicRead } from './public-project-sanitizer';
import { getProject } from './project-service';
import { getDefaultWorkspaceDir, getDefaultProjectRoot } from './storage';
import { openDirectoryPicker } from './directory-picker';
import type { EngineName } from './engines/types';
import { attachmentService } from './attachment-service';
import {
  normalizeAttachmentCleanupRequest,
  parseAttachmentStatsPageValue,
} from './attachment-inventory-limits';
import { openProjectDirectory, openFileInVSCode } from './open-project';
import {
  AGENT_PAYLOAD_TOO_LARGE,
  isAgentPayloadLimitError,
  toAgentPayloadErrorResponse,
  validateAgentActPayload,
  validateAgentMessageFields,
  validateStoredMessagePayload,
} from './payload-limits';
import {
  AGENT_ATTACHMENT_MAX_BYTES,
  AGENT_ATTACHMENT_RPC_CHUNK_BYTES,
  AGENT_ATTACHMENT_RPC_INLINE_BYTES,
  AGENT_PROJECT_NAME_MAX_BYTES,
  type AgentRpcRequestPayload,
  type AttachmentCleanupResponse,
  type AttachmentStatsResponse,
  type OpenProjectTarget,
} from 'webpage-mcp-shared';

const VALID_OPEN_TARGETS: readonly OpenProjectTarget[] = ['vscode', 'terminal'];
const ATTACHMENT_ROOT_DISPLAY_PATH = 'attachments';
const DEFAULT_COLLECTION_PAGE_LIMIT = 50;
const DEFAULT_PROJECT_MESSAGE_LIMIT = 50;
const DEFAULT_SESSION_HISTORY_LIMIT = 100;
const MAX_COLLECTION_PAGE_LIMIT = 500;
export const AGENT_RPC_JSON_RESPONSE_MAX_BYTES = 700 * 1024;
export const AGENT_RPC_COLLECTION_PAGE_FETCH_LIMIT = 16;

interface CollectionPagePagination {
  limit: number;
  offset: number;
  count: number;
  hasMore: boolean;
  nextOffset: number | null;
}

function normalizeCollectionPageLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || value <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), MAX_COLLECTION_PAGE_LIMIT);
}

function jsonUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('RPC response payload is not JSON serializable');
  }
  return Buffer.byteLength(serialized, 'utf8');
}

/**
 * Fit a collection page to the native RPC response budget using the exact
 * JSON representation of every item, including string escaping.
 */
function createBoundedCollectionPage<T>(options: {
  items: readonly T[];
  totalCount: number;
  limit: number;
  offset: number;
  buildPayload: (items: readonly T[], pagination: CollectionPagePagination) => unknown;
}): unknown {
  const selected: T[] = [];
  let selectedItemBytes = 0;

  for (const item of options.items) {
    const nextCount = selected.length + 1;
    const nextHasMore = options.offset + nextCount < options.totalCount;
    const pagination: CollectionPagePagination = {
      limit: options.limit,
      offset: options.offset,
      count: nextCount,
      hasMore: nextHasMore,
      nextOffset: nextHasMore ? options.offset + nextCount : null,
    };
    const skeletonBytes = jsonUtf8Bytes(options.buildPayload([], pagination));
    const itemBytes = jsonUtf8Bytes(item);
    const arrayContentsBytes = selectedItemBytes + itemBytes + selected.length;

    // Replacing the skeleton's [] with the serialized items adds exactly the
    // item bytes plus one comma per item after the first.
    if (skeletonBytes + arrayContentsBytes > AGENT_RPC_JSON_RESPONSE_MAX_BYTES) {
      break;
    }

    selected.push(item);
    selectedItemBytes += itemBytes;
  }

  if (options.items.length > 0 && selected.length === 0) {
    throw new RangeError('A collection item exceeds the Agent RPC response byte budget');
  }

  const hasMore = options.offset + selected.length < options.totalCount;
  const pagination: CollectionPagePagination = {
    limit: options.limit,
    offset: options.offset,
    count: selected.length,
    hasMore,
    nextOffset: hasMore ? options.offset + selected.length : null,
  };
  const payload = options.buildPayload(selected, pagination);

  // Keep this invariant adjacent to the returned value so future envelope
  // fields cannot silently invalidate the sizing calculation above.
  if (jsonUtf8Bytes(payload) > AGENT_RPC_JSON_RESPONSE_MAX_BYTES) {
    throw new RangeError('Agent RPC response exceeds its JSON byte budget');
  }
  return payload;
}

function toPublicAttachmentDirPath(projectId: string): string {
  return `${ATTACHMENT_ROOT_DISPLAY_PATH}/${projectId}`;
}

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
  const successful = statusCode >= 200 && statusCode < 300;
  const errorMessage =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).error
      : undefined;
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    // Native responses carry structured data in `json`. Keeping a second
    // serialized copy in `body` can push otherwise valid pages over Chrome's
    // 1 MiB native-message limit. Error callers still rely on a readable body.
    body: successful
      ? ''
      : typeof errorMessage === 'string' && errorMessage.trim()
        ? errorMessage
        : JSON.stringify(payload),
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

function binaryResponse(
  buffer: Buffer,
  contentType: string,
  options: {
    statusCode?: number;
    headers?: Record<string, unknown>;
  } = {},
): RpcDispatchResponse {
  return {
    statusCode: options.statusCode ?? HTTP_STATUS.OK,
    headers: {
      'content-type': contentType,
      'content-length': String(buffer.length),
      'cache-control': 'public, max-age=31536000, immutable',
      ...options.headers,
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

function readProjectIdParam(params: Record<string, unknown> | undefined): string {
  const value = params?.projectId;
  validateProjectIdentifier(value);
  return value.trim();
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

function toAgentActRequest(payload: Record<string, unknown>): AgentActRequest {
  return {
    instruction: readString(payload.instruction) ?? '',
    cliPreference: readString(payload.cliPreference) as AgentActRequest['cliPreference'],
    model: readString(payload.model),
    attachments: Array.isArray(payload.attachments)
      ? (payload.attachments as AgentActRequest['attachments'])
      : undefined,
    context:
      payload.context && typeof payload.context === 'object' && !Array.isArray(payload.context)
        ? (payload.context as AgentActRequest['context'])
        : undefined,
    projectId: readString(payload.projectId),
    dbSessionId: readString(payload.dbSessionId),
    projectRoot: readString(payload.projectRoot),
    requestId: readString(payload.requestId),
    clientMeta:
      payload.clientMeta &&
      typeof payload.clientMeta === 'object' &&
      !Array.isArray(payload.clientMeta)
        ? (payload.clientMeta as Record<string, unknown>)
        : undefined,
    displayText: readString(payload.displayText),
  };
}

function readOpenTargetFromBody(payload: Record<string, unknown>): string | undefined {
  validateProjectOpenTarget(payload.target);
  return payload.target.trim();
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

      case 'agent.engines.list': {
        const engines = deps.chatService.getEngineInfos();
        return jsonResponse(HTTP_STATUS.OK, { engines });
      }

      case 'agent.projects.list': {
        const limit = readNumber(readQueryValue(query, 'limit'));
        const offset = readNumber(readQueryValue(query, 'offset'));
        const safeLimit = normalizeCollectionPageLimit(limit, DEFAULT_COLLECTION_PAGE_LIMIT);
        const fetchLimit = Math.min(safeLimit, AGENT_RPC_COLLECTION_PAGE_FETCH_LIMIT);
        const safeOffset = typeof offset === 'number' && offset >= 0 ? Math.floor(offset) : 0;
        const [projects, totalCount] = await Promise.all([
          listProjects(fetchLimit, safeOffset),
          getProjectsCount(),
        ]);
        const payload = createBoundedCollectionPage({
          items: projects.map(sanitizeProjectForPublicRead),
          totalCount,
          limit: safeLimit,
          offset: safeOffset,
          buildPayload: (pageProjects, pagination) => ({
            projects: pageProjects,
            totalCount,
            pagination,
          }),
        });
        return jsonResponse(HTTP_STATUS.OK, payload);
      }

      case 'agent.projects.upsert': {
        const validEngineNames = getRegisteredEngineNames(deps.chatService);
        const normalizedPayload = normalizeBody(body);
        validateProjectUpsertPayload(normalizedPayload);
        const rawPayload = normalizedPayload;
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
        const project = sanitizeProjectForPublicRead(await upsertProject(payload));
        return jsonResponse(HTTP_STATUS.OK, { project });
      }

      case 'agent.projects.delete': {
        const projectId = readProjectIdParam(params);
        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'project id is required' });
        }
        return deps.chatService.withProjectLifecycleMutation(
          projectId,
          async () => (await getSessionsByProject(projectId)).map((session) => session.id),
          async () => {
            const project = await getProject(projectId);
            if (!project) {
              return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Project not found' });
            }
            await deleteProject(projectId);
            return noContentResponse();
          },
        );
      }

      case 'agent.projects.validatePath': {
        const payload = bodyAsRecord(body);
        validateProjectPath(payload.rootPath, 'rootPath');
        const rootPath = payload.rootPath;
        const result = await validateRootPath(rootPath);
        return jsonResponse(HTTP_STATUS.OK, result);
      }

      case 'agent.projects.createDirectory': {
        const payload = bodyAsRecord(body);
        validateProjectPath(payload.absolutePath, 'absolutePath');
        const absolutePath = payload.absolutePath;
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
        validateProjectName(payload.projectName);
        const projectName = payload.projectName;
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
        const limit = readNumber(readQueryValue(query, 'limit'));
        const offset = readNumber(readQueryValue(query, 'offset'));
        const safeLimit = normalizeCollectionPageLimit(limit, DEFAULT_COLLECTION_PAGE_LIMIT);
        const fetchLimit = Math.min(safeLimit, AGENT_RPC_COLLECTION_PAGE_FETCH_LIMIT);
        const safeOffset = typeof offset === 'number' && offset >= 0 ? Math.floor(offset) : 0;
        const [sessions, totalCount] = await Promise.all([
          getAllSessions(fetchLimit, safeOffset),
          getAllSessionsCount(),
        ]);
        const payload = createBoundedCollectionPage({
          items: sessions.map(sanitizeSessionForPublicRead),
          totalCount,
          limit: safeLimit,
          offset: safeOffset,
          buildPayload: (pageSessions, pagination) => ({
            sessions: pageSessions,
            totalCount,
            pagination,
          }),
        });
        return jsonResponse(HTTP_STATUS.OK, payload);
      }

      case 'agent.projects.sessions.list': {
        const projectId = readProjectIdParam(params);
        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'projectId is required' });
        }
        const project = await getProject(projectId);
        if (!project) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Project not found' });
        }
        const limit = readNumber(readQueryValue(query, 'limit'));
        const offset = readNumber(readQueryValue(query, 'offset'));
        const safeLimit = normalizeCollectionPageLimit(limit, DEFAULT_COLLECTION_PAGE_LIMIT);
        const fetchLimit = Math.min(safeLimit, AGENT_RPC_COLLECTION_PAGE_FETCH_LIMIT);
        const safeOffset = typeof offset === 'number' && offset >= 0 ? Math.floor(offset) : 0;
        const [sessions, totalCount] = await Promise.all([
          getSessionsByProject(projectId, fetchLimit, safeOffset),
          getSessionsCountByProject(projectId),
        ]);
        const payload = createBoundedCollectionPage({
          items: sessions.map(sanitizeSessionForPublicRead),
          totalCount,
          limit: safeLimit,
          offset: safeOffset,
          buildPayload: (pageSessions, pagination) => ({
            sessions: pageSessions,
            totalCount,
            pagination,
          }),
        });
        return jsonResponse(HTTP_STATUS.OK, payload);
      }

      case 'agent.projects.sessions.create': {
        const validEngineNames = getRegisteredEngineNames(deps.chatService);
        const projectId = readProjectIdParam(params);
        const payload = bodyAsRecord(body) as CreateSessionOptions & { engineName?: string };

        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'projectId is required' });
        }
        if (!payload.engineName) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'engineName is required' });
        }
        validateSessionCreatePayload(projectId, payload.engineName, payload);
        if (payload.engineSessionId !== undefined) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            error: 'engineSessionId is managed by the engine and cannot be set',
          });
        }
        if (!isValidEngineName(payload.engineName, validEngineNames)) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            error: `Invalid engineName. Must be one of: ${validEngineNames.join(', ')}`,
          });
        }

        const securityConfigError = validateSessionSecurityConfig({
          engineName: payload.engineName,
          input: payload,
        });
        if (securityConfigError) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: securityConfigError });
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

        return jsonResponse(HTTP_STATUS.CREATED, { session: sanitizeSessionForPublicRead(session) });
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
        return jsonResponse(HTTP_STATUS.OK, { session: sanitizeSessionForPublicRead(session) });
      }

      case 'agent.sessions.update': {
        const sessionId = readParam(params, 'sessionId');
        const updates = bodyAsRecord(body) as UpdateSessionInput;

        if (!sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'sessionId is required' });
        }
        validateSessionUpdatePayload(sessionId, updates);
        if (updates.engineSessionId !== undefined) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            error: 'engineSessionId is managed by the engine and cannot be set',
          });
        }
        if (updates.managementInfo !== undefined) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            error: 'managementInfo is managed by the engine and cannot be set',
          });
        }

        const existing = await getSession(sessionId);
        if (!existing) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Session not found' });
        }

        if (existing.engineName === 'claude' || existing.engineName === 'codex') {
          const securityConfigError = validateSessionSecurityConfig({
            engineName: existing.engineName,
            input: updates,
            existing,
            update: true,
          });
          if (securityConfigError) {
            return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: securityConfigError });
          }
        }

        await updateSession(sessionId, updates);
        const updated = await getSession(sessionId);
        return jsonResponse(HTTP_STATUS.OK, {
          session: updated ? sanitizeSessionForPublicRead(updated) : updated,
        });
      }

      case 'agent.sessions.delete': {
        const sessionId = readParam(params, 'sessionId');
        if (!sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'sessionId is required' });
        }
        return deps.chatService.withSessionLifecycleMutation(sessionId, async () => {
          const existing = await getSession(sessionId);
          if (!existing) {
            return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Session not found' });
          }
          await deleteSession(sessionId);
          return noContentResponse();
        });
      }

      case 'agent.sessions.history': {
        const sessionId = readParam(params, 'sessionId');
        if (!sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'sessionId is required' });
        }

        const limit = readNumber(readQueryValue(query, 'limit'));
        const offset = readNumber(readQueryValue(query, 'offset'));
        const safeLimit = normalizeCollectionPageLimit(limit, DEFAULT_SESSION_HISTORY_LIMIT);
        const fetchLimit = Math.min(safeLimit, AGENT_RPC_COLLECTION_PAGE_FETCH_LIMIT);
        const safeOffset = typeof offset === 'number' && offset >= 0 ? Math.floor(offset) : 0;

        const session = await getSession(sessionId);
        if (!session) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Session not found' });
        }

        const [messages, totalCount] = await Promise.all([
          getMessagesBySessionId(sessionId, fetchLimit, safeOffset, session.projectId),
          getMessagesCountBySessionId(sessionId, session.projectId),
        ]);

        const payload = createBoundedCollectionPage({
          items: messages,
          totalCount,
          limit: safeLimit,
          offset: safeOffset,
          buildPayload: (pageMessages, pagination) => ({
            success: true,
            sessionId,
            messages: pageMessages,
            totalCount,
            pagination,
          }),
        });
        return jsonResponse(HTTP_STATUS.OK, payload);
      }

      case 'agent.sessions.reset': {
        const sessionId = readParam(params, 'sessionId');
        if (!sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'sessionId is required' });
        }

        return deps.chatService.withSessionLifecycleMutation(sessionId, async () => {
          const existing = await getSession(sessionId);
          if (!existing) {
            return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Session not found' });
          }

          await updateSession(sessionId, { engineSessionId: null });
          const deletedMessages = await deleteMessagesBySessionId(sessionId, existing.projectId);
          const updated = await getSession(sessionId);

          return jsonResponse(HTTP_STATUS.OK, {
            success: true,
            sessionId,
            deletedMessages,
            clearedEngineSessionId: Boolean(existing.engineSessionId),
            session: updated ? sanitizeSessionForPublicRead(updated) : null,
          });
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
          managementInfo: sanitizeManagementInfoForPublicRead(session.managementInfo) ?? null,
          sessionId,
          engineName: session.engineName,
        });
      }

      case 'agent.projects.claudeInfo': {
        const projectId = readProjectIdParam(params);
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
          managementInfo: sanitizeManagementInfoForPublicRead(latestInfo) ?? null,
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
        const projectId = readProjectIdParam(params);
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
        const projectId = readProjectIdParam(params);
        const payload = bodyAsRecord(body);
        validateProjectOpenFilePayload(payload.filePath, payload.line, payload.column);
        const filePath = payload.filePath;
        const line = payload.line as number | undefined;
        const column = payload.column as number | undefined;

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
        const projectId = readProjectIdParam(params);
        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'projectId is required' });
        }
        const project = await getProject(projectId);
        if (!project) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Project not found' });
        }

        const limit = readNumber(readQueryValue(query, 'limit'));
        const offset = readNumber(readQueryValue(query, 'offset'));
        const safeLimit = normalizeCollectionPageLimit(limit, DEFAULT_PROJECT_MESSAGE_LIMIT);
        const fetchLimit = Math.min(safeLimit, AGENT_RPC_COLLECTION_PAGE_FETCH_LIMIT);
        const safeOffset = typeof offset === 'number' && offset >= 0 ? Math.floor(offset) : 0;

        const [messages, totalCount] = await Promise.all([
          getMessagesByProjectId(projectId, fetchLimit, safeOffset),
          getMessagesCountByProjectId(projectId),
        ]);

        const payload = createBoundedCollectionPage({
          items: messages,
          totalCount,
          limit: safeLimit,
          offset: safeOffset,
          buildPayload: (pageMessages, pagination) => ({
            success: true,
            data: pageMessages,
            totalCount,
            pagination,
          }),
        });
        return jsonResponse(HTTP_STATUS.OK, payload);
      }

      case 'agent.chat.messages.create': {
        const projectId = readProjectIdParam(params);
        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'projectId is required' });
        }

        const payload = bodyAsRecord(body);
        const rawContent = readString(payload.content) || '';
        const content = rawContent.trim();
        validateAgentMessageFields(rawContent, payload.metadata);
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

        const messageInput = {
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
        };
        validateStoredMessagePayload(messageInput);

        const project = await getProject(projectId);
        if (!project) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Project not found' });
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

        const stored = await createStoredMessage(messageInput);

        return jsonResponse(HTTP_STATUS.CREATED, { success: true, data: stored });
      }

      case 'agent.chat.messages.delete': {
        const projectId = readProjectIdParam(params);
        if (!projectId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: 'projectId is required' });
        }
        const project = await getProject(projectId);
        if (!project) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Project not found' });
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
        const payloadRecord = payload as Record<string, unknown>;
        validateAgentActPayload(payloadRecord, { sessionId });
        const attachmentError = validateAgentAttachments(payloadRecord.attachments);
        if (attachmentError) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: attachmentError });
        }

        const session = await getSession(sessionId);
        if (!session) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, {
            error: 'Session not found',
          });
        }

        const rawDbSessionId =
          typeof payloadRecord.dbSessionId === 'string' ? payloadRecord.dbSessionId.trim() : '';
        if (rawDbSessionId && rawDbSessionId !== sessionId) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            error: 'dbSessionId must match the sessionId path parameter',
          });
        }

        let requestId: string;
        try {
          ({ requestId } = await deps.chatService.handleAct(sessionId, {
            ...toAgentActRequest(payloadRecord),
            dbSessionId: sessionId,
          }));
        } catch (error) {
          const message = normalizeError(error);
          if (
            message === 'requestId is already active for this session' ||
            message.includes('lifecycle mutation in progress')
          ) {
            return jsonResponse(HTTP_STATUS.CONFLICT, { error: message });
          }
          throw error;
        }
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
        const session = await getSession(sessionId);
        if (!session) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Session not found' });
        }

        const cancelled = deps.chatService.cancelExecution(sessionId, requestId);
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
        const session = await getSession(sessionId);
        if (!session) {
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Session not found' });
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
        const limit = parseAttachmentStatsPageValue(
          readQueryValue(query, 'limit'),
          'limit',
        );
        const offset = parseAttachmentStatsPageValue(
          readQueryValue(query, 'offset'),
          'offset',
        );
        const stats = await attachmentService.getAttachmentStats({ limit, offset });
        const pageProjects = await Promise.all(
          stats.projects.map((entry) => getProject(entry.projectId)),
        );
        const dbProjectIds = new Set(
          pageProjects.flatMap((project) => (project ? [project.id] : [])),
        );
        const projectMap = new Map(
          pageProjects.flatMap((project) => {
            if (
              !project ||
              jsonUtf8Bytes(project.name) > AGENT_PROJECT_NAME_MAX_BYTES
            ) {
              return [];
            }
            return [[project.id, project.name] as const];
          }),
        );

        const enrichedProjects = stats.projects.map((p) => ({
          ...p,
          dirPath: toPublicAttachmentDirPath(p.projectId),
          projectName: projectMap.get(p.projectId),
          existsInDb: dbProjectIds.has(p.projectId),
        }));

        const orphanProjectIds = stats.projects
          .filter((p) => !dbProjectIds.has(p.projectId))
          .map((p) => p.projectId);

        const response: AttachmentStatsResponse = {
          success: true,
          rootDir: ATTACHMENT_ROOT_DISPLAY_PATH,
          pathRedacted: true,
          totalFiles: stats.totalFiles,
          totalBytes: stats.totalBytes,
          inventoryTruncated: stats.inventoryTruncated,
          truncatedProjects: stats.truncatedProjects,
          pagination: stats.pagination,
          projects: enrichedProjects,
          orphanProjectIds,
        };
        if (jsonUtf8Bytes(response) > AGENT_RPC_JSON_RESPONSE_MAX_BYTES) {
          throw new RangeError('Attachment stats response exceeds its JSON byte budget');
        }
        return jsonResponse(HTTP_STATUS.OK, response);
      }

      case 'agent.attachments.get': {
        const projectId = readParam(params, 'projectId');
        const filename = readParam(params, 'filename');
        const rawOffset = readQueryValue(query, 'offset');
        const rawLimit = readQueryValue(query, 'limit');
        const hasOffset = rawOffset !== undefined;
        const hasLimit = rawLimit !== undefined;

        if (hasOffset !== hasLimit) {
          return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
            error: 'attachment offset and limit must be provided together',
          });
        }

        let offset = 0;
        let maxBytes = AGENT_ATTACHMENT_RPC_INLINE_BYTES;
        if (hasOffset && hasLimit) {
          const requestedOffset = readNumber(rawOffset);
          const requestedLimit = readNumber(rawLimit);
          if (
            requestedOffset === undefined ||
            !Number.isSafeInteger(requestedOffset) ||
            requestedOffset < 0 ||
            requestedLimit === undefined ||
            !Number.isSafeInteger(requestedLimit) ||
            requestedLimit <= 0
          ) {
            return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
              error: 'attachment offset must be a non-negative safe integer and limit must be positive',
            });
          }
          offset = requestedOffset;
          maxBytes = Math.min(requestedLimit, AGENT_ATTACHMENT_RPC_CHUNK_BYTES);
        }

        try {
          const project = await getProject(projectId);
          if (!project) {
            return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Project not found' });
          }

          const chunk = await attachmentService.readAttachmentChunk(
            projectId,
            filename,
            offset,
            maxBytes,
            AGENT_ATTACHMENT_MAX_BYTES,
          );

          if (chunk.totalBytes > AGENT_ATTACHMENT_MAX_BYTES) {
            return jsonResponse(HTTP_STATUS.PAYLOAD_TOO_LARGE, {
              error: `Attachment exceeds the ${AGENT_ATTACHMENT_MAX_BYTES}-byte limit`,
              code: 'ATTACHMENT_TOO_LARGE',
              totalBytes: chunk.totalBytes,
              maxBytes: AGENT_ATTACHMENT_MAX_BYTES,
            });
          }

          if (!hasOffset && chunk.totalBytes > AGENT_ATTACHMENT_RPC_INLINE_BYTES) {
            return jsonResponse(HTTP_STATUS.PAYLOAD_TOO_LARGE, {
              error: 'Attachment requires ranged transfer',
              code: 'ATTACHMENT_RANGE_REQUIRED',
              totalBytes: chunk.totalBytes,
              maxChunkBytes: AGENT_ATTACHMENT_RPC_CHUNK_BYTES,
            });
          }

          if (hasOffset && offset >= chunk.totalBytes) {
            const response = jsonResponse(HTTP_STATUS.RANGE_NOT_SATISFIABLE, {
              error: 'Attachment range is not satisfiable',
              code: 'ATTACHMENT_RANGE_NOT_SATISFIABLE',
              totalBytes: chunk.totalBytes,
            });
            response.headers['content-range'] = `bytes */${chunk.totalBytes}`;
            return response;
          }

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

          if (hasOffset) {
            const end = offset + chunk.buffer.length - 1;
            return binaryResponse(chunk.buffer, contentType, {
              statusCode: HTTP_STATUS.PARTIAL_CONTENT,
              headers: {
                'accept-ranges': 'bytes',
                'content-range': `bytes ${offset}-${end}/${chunk.totalBytes}`,
              },
            });
          }

          return binaryResponse(chunk.buffer, contentType);
        } catch (error) {
          const message = normalizeError(error);
          if (message.includes('Invalid') || message.includes('traversal')) {
            return jsonResponse(HTTP_STATUS.BAD_REQUEST, { error: message });
          }
          return jsonResponse(HTTP_STATUS.NOT_FOUND, { error: 'Attachment not found' });
        }
      }

      case 'agent.attachments.deleteByProject': {
        const cleanupRequest = normalizeAttachmentCleanupRequest({
          projectIds: [params?.projectId],
        });
        const projectId = cleanupRequest.projectIds?.[0] ?? '';
        const result = await attachmentService.cleanupAttachments({ projectIds: [projectId] });

        const response: AttachmentCleanupResponse = {
          success: true,
          scope: 'project',
          pathRedacted: true,
          removedFiles: result.removedFiles,
          removedBytes: result.removedBytes,
          processedProjects: result.processedProjects,
          failedProjects: result.failedProjects,
          skippedProjects: result.skippedProjects,
          resultCount: result.resultCount,
          resultsTruncated: result.resultsTruncated,
          enumerationTruncated: result.enumerationTruncated,
          results: result.results.map((entry) => ({
            ...entry,
            dirPath: toPublicAttachmentDirPath(entry.projectId),
          })),
        };
        if (jsonUtf8Bytes(response) > AGENT_RPC_JSON_RESPONSE_MAX_BYTES) {
          throw new RangeError('Attachment cleanup response exceeds its JSON byte budget');
        }
        return jsonResponse(HTTP_STATUS.OK, response);
      }

      case 'agent.attachments.deleteAll': {
        const cleanupRequest = normalizeAttachmentCleanupRequest(normalizeBody(body));
        const projectIds = cleanupRequest.projectIds;
        const result = await attachmentService.cleanupAttachments(
          cleanupRequest.selected ? { projectIds: projectIds ?? [] } : undefined,
          { continueOnError: true },
        );

        const response: AttachmentCleanupResponse = {
          success: true,
          scope: cleanupRequest.selected ? 'selected' : 'all',
          pathRedacted: true,
          removedFiles: result.removedFiles,
          removedBytes: result.removedBytes,
          processedProjects: result.processedProjects,
          failedProjects: result.failedProjects,
          skippedProjects: result.skippedProjects,
          resultCount: result.resultCount,
          resultsTruncated: result.resultsTruncated,
          enumerationTruncated: result.enumerationTruncated,
          results: result.results.map((entry) => ({
            ...entry,
            dirPath: toPublicAttachmentDirPath(entry.projectId),
          })),
        };
        if (jsonUtf8Bytes(response) > AGENT_RPC_JSON_RESPONSE_MAX_BYTES) {
          throw new RangeError('Attachment cleanup response exceeds its JSON byte budget');
        }
        return jsonResponse(HTTP_STATUS.OK, response);
      }

      default:
        return jsonResponse(HTTP_STATUS.BAD_REQUEST, {
          error: `Unsupported RPC operation: ${operation}`,
        });
    }
  } catch (error) {
    if (isAgentPayloadLimitError(error)) {
      return jsonResponse(
        error.code === AGENT_PAYLOAD_TOO_LARGE
          ? HTTP_STATUS.PAYLOAD_TOO_LARGE
          : HTTP_STATUS.BAD_REQUEST,
        toAgentPayloadErrorResponse(error),
      );
    }
    return jsonResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, {
      error: normalizeError(error) || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
}
