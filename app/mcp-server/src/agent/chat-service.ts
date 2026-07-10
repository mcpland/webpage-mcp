import { randomUUID } from 'node:crypto';
import type { AgentActRequest } from './types';
import type {
  AgentEngine,
  EngineExecutionContext,
  EngineName,
  EngineInitOptions,
  RunningExecution,
} from './engines/types';
import type { AgentMessage, RealtimeEvent } from './types';
import type { AttachmentMetadata } from 'webpage-mcp-shared';
import { AgentStreamManager } from './stream-manager';
import { getProject, touchProjectActivity, updateProjectClaudeSessionId } from './project-service';
import { createMessage as persistAgentMessage } from './message-service';
import {
  getSession,
  updateEngineSessionId,
  updateManagementInfo,
  updateSessionEngineName,
  touchSessionActivity,
  type AgentSession,
} from './session-service';
import { attachmentService, type SavedAttachment } from './attachment-service';
import { validateAgentAttachments } from './attachment-limits';
import { validateAgentActPayload, validateFinalAgentPrompt } from './payload-limits';

export interface AgentChatServiceOptions {
  engines: AgentEngine[];
  streamManager: AgentStreamManager;
  defaultEngineName?: EngineName;
}

export const AGENT_EXECUTION_LIMITS = Object.freeze({
  maxGlobal: 16,
  maxPerSession: 4,
  maxPerProject: 8,
});

type ExecutionPhase = 'preparing' | 'running' | 'settled';

interface ExecutionRecord extends RunningExecution {
  phase: ExecutionPhase;
  scopeReady: Promise<void>;
  resolveScopeReady: () => void;
  resolveSettled: () => void;
  scopeResolved: boolean;
  pendingPersistence: Set<Promise<void>>;
  settling?: Promise<void>;
}

function executionKey(sessionId: string, requestId: string): string {
  return `${sessionId}::${requestId}`;
}

function normalizeContextString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function buildInstructionWithContext(
  instruction: string,
  context: AgentActRequest['context'],
): string {
  if (!context) {
    return instruction;
  }

  const pageUrl = normalizeContextString(context.pageUrl);
  const selectedText = normalizeContextString(context.selectedText);
  let elementInfoText = '';

  if (context.elementInfo !== undefined) {
    try {
      const serialized = JSON.stringify(context.elementInfo);
      if (typeof serialized === 'string' && serialized !== '{}' && serialized !== '[]') {
        elementInfoText = serialized;
      }
    } catch {
      // Ignore unserializable element info
    }
  }

  if (!pageUrl && !selectedText && !elementInfoText) {
    return instruction;
  }

  const lines = [instruction, '', 'Additional page context:'];
  if (pageUrl) {
    lines.push(`- Page URL: ${pageUrl}`);
  }
  if (selectedText) {
    lines.push('- Selected text:');
    lines.push('```text');
    lines.push(selectedText);
    lines.push('```');
  }
  if (elementInfoText) {
    lines.push(`- Element info: ${elementInfoText}`);
  }
  return lines.join('\n');
}

/**
 * AgentChatService coordinates incoming agent.chat operations and delegates to engines.
 *
 * Note:This service is responsible for session-level scheduling and is not concerned with specific CLI/SDK implementation details.
 * Dependency inversion is implemented through the Engine interface, so there is no need to modify the RPC dispatch layer when replacing or adding new engines.
 */
export class AgentChatService {
  private readonly engines = new Map<EngineName, AgentEngine>();
  private readonly streamManager: AgentStreamManager;
  private readonly defaultEngineName: EngineName;

  /**
   * Registry of all executions, including preparation, keyed by sessionId + requestId.
   */
  private readonly runningExecutions = new Map<string, ExecutionRecord>();
  /** Lifecycle tombstones reject new work until the destructive mutation completes. */
  private readonly mutatingProjects = new Set<string>();
  private readonly mutatingSessions = new Set<string>();

  constructor(options: AgentChatServiceOptions) {
    this.streamManager = options.streamManager;

    for (const engine of options.engines) {
      this.engines.set(engine.name, engine);
    }

    if (options.defaultEngineName && this.engines.has(options.defaultEngineName)) {
      this.defaultEngineName = options.defaultEngineName;
    } else {
      // Fallback to first registered engine to avoid hard-coding 'claude' here.
      const firstEngine = options.engines[0];
      if (!firstEngine) {
        throw new Error('AgentChatService requires at least one engine');
      }
      this.defaultEngineName = firstEngine.name;
    }
  }

  private hasRegisteredEngine(name: unknown): name is EngineName {
    return typeof name === 'string' && this.engines.has(name as EngineName);
  }

  async handleAct(sessionId: string, payload: AgentActRequest): Promise<{ requestId: string }> {
    validateAgentActPayload(payload, { sessionId });
    const trimmed = payload.instruction?.trim();
    if (!trimmed) {
      throw new Error('instruction is required');
    }
    const attachmentError = validateAgentAttachments(payload.attachments);
    if (attachmentError) throw new Error(attachmentError);
    const engineInstruction = buildInstructionWithContext(trimmed, payload.context);
    validateFinalAgentPrompt(engineInstruction);

    const requestId = payload.requestId || randomUUID();
    const execution = this.reserveExecution(sessionId, requestId, payload);

    try {
      return await this.handleReservedAct(
        sessionId,
        payload,
        trimmed,
        engineInstruction,
        requestId,
        execution,
      );
    } catch (error) {
      await this.settleExecution(execution);
      throw error;
    }
  }

  private async handleReservedAct(
    sessionId: string,
    payload: AgentActRequest,
    trimmed: string,
    engineInstruction: string,
    requestId: string,
    execution: ExecutionRecord,
  ): Promise<{ requestId: string }> {
    let projectId = execution.projectId;
    // Normalize empty string to undefined
    const rawDbSessionId =
      typeof payload.dbSessionId === 'string' ? payload.dbSessionId.trim() : '';
    const dbSessionId = rawDbSessionId || undefined;
    execution.dbSessionId = dbSessionId;

    // Load session from database if dbSessionId is provided
    let dbSession: AgentSession | undefined;
    if (dbSessionId) {
      dbSession = await getSession(dbSessionId);
      this.ensureExecutionActive(execution);
      if (!dbSession) {
        throw new Error(`Session not found for id: ${dbSessionId}`);
      }
      // Validate project association
      if (projectId && dbSession.projectId !== projectId) {
        throw new Error(`Session ${dbSessionId} does not belong to project: ${projectId}`);
      }
      // Use session's project if not explicitly provided
      if (!projectId) {
        projectId = dbSession.projectId;
      }
    }

    // Project is required - workspace path must come from project system
    if (!projectId) {
      throw new Error('projectId is required. Please select or create a project first.');
    }

    this.associateExecutionProject(execution, projectId);

    const project = await getProject(projectId);
    this.ensureExecutionActive(execution);
    if (!project) {
      throw new Error(`Project not found for id: ${projectId}`);
    }

    const projectRoot = project.rootPath;
    const projectPreferredCli = project.preferredCli as EngineName | undefined;
    const projectSelectedModel = project.selectedModel;

    // Legacy fallback: if caller does not use sessions table, use project-level resume id
    let resumeClaudeSessionId: string | undefined;
    if (!dbSessionId) {
      resumeClaudeSessionId = project.activeClaudeSessionId;
    }

    // Resolve engine name - session binding takes precedence
    let engineName: EngineName;
    if (dbSession) {
      const sessionEngineName =
        typeof dbSession.engineName === 'string' ? dbSession.engineName.trim() : '';
      if (this.hasRegisteredEngine(sessionEngineName)) {
        engineName = sessionEngineName;
        // Validate cliPreference matches session engine
        if (payload.cliPreference && payload.cliPreference !== engineName) {
          throw new Error(
            `cliPreference (${payload.cliPreference}) does not match session.engineName (${engineName})`,
          );
        }
      } else {
        engineName = this.resolveEngineName(
          payload.cliPreference as EngineName | undefined,
          projectPreferredCli,
        );
        await updateSessionEngineName(dbSession.id, engineName);
        this.ensureExecutionActive(execution);
        dbSession.engineName = engineName;
        dbSession.engineSessionId = undefined;
        dbSession.model = undefined;
        console.warn(
          `[AgentChatService] Migrated legacy session "${dbSession.id}" from unsupported engine "${sessionEngineName || 'unknown'}" to "${engineName}"`,
        );
      }
    } else {
      engineName = this.resolveEngineName(
        payload.cliPreference as EngineName | undefined,
        projectPreferredCli,
      );
    }

    const engine = this.engines.get(engineName);
    if (!engine) {
      throw new Error(`No agent engine registered for ${engineName}`);
    }

    // Model priority: request > session > project
    const effectiveModel = payload.model?.trim() || dbSession?.model || projectSelectedModel;

    // For Claude engine with session, use session's engineSessionId for resume
    if (dbSession && engineName === 'claude') {
      resumeClaudeSessionId = dbSession.engineSessionId;
    }

    const now = new Date().toISOString();
    const userMessageId = randomUUID();

    // Process and persist image attachments
    const savedAttachments: SavedAttachment[] = [];
    let attachmentMetadata: AttachmentMetadata[] | undefined;
    let resolvedImagePaths: string[] | undefined;

    if (projectId && payload.attachments && payload.attachments.length > 0) {
      const imageAttachments = payload.attachments.filter((a) => a.type === 'image');

      if (imageAttachments.length > 0) {
        try {
          console.error(
            `[AgentChatService] Saving ${imageAttachments.length} image attachment(s) for project ${projectId}`,
          );

          for (let i = 0; i < imageAttachments.length; i++) {
            const attachment = imageAttachments[i];
            const saved = await attachmentService.saveAttachment({
              projectId,
              messageId: userMessageId,
              attachment,
              index: i,
            });
            savedAttachments.push(saved);
            this.ensureExecutionActive(execution);
          }

          // Build metadata array for message persistence
          attachmentMetadata = savedAttachments.map((s) => s.metadata);
          // Build paths array for engine consumption
          resolvedImagePaths = savedAttachments.map((s) => s.absolutePath);

          console.error(
            `[AgentChatService] Saved ${savedAttachments.length} attachment(s): ${resolvedImagePaths.join(', ')}`,
          );
        } catch (error) {
          console.error('[AgentChatService] Failed to save attachments:', error);
          await this.rollbackAttachments(projectId, savedAttachments);
          throw new Error(
            `Failed to save attachments: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Build metadata object for user message
    // Include attachments, clientMeta, and displayText if present
    let userMessageMetadata: Record<string, unknown> | undefined;
    const hasAttachments = attachmentMetadata && attachmentMetadata.length > 0;
    const hasClientMeta = payload.clientMeta !== undefined;
    const hasDisplayText = payload.displayText !== undefined;

    if (hasAttachments || hasClientMeta || hasDisplayText) {
      userMessageMetadata = {};
      if (hasAttachments) {
        userMessageMetadata.attachments = attachmentMetadata;
      }
      if (hasClientMeta) {
        userMessageMetadata.clientMeta = payload.clientMeta;
      }
      if (hasDisplayText) {
        userMessageMetadata.displayText = payload.displayText;
      }
    }

    // Emit a canonical user message into the stream so UI can render from server events only.
    const userMessage: AgentMessage = {
      id: userMessageId,
      sessionId,
      role: 'user',
      content: trimmed,
      messageType: 'chat',
      cliSource: engineName,
      requestId,
      isStreaming: false,
      isFinal: true,
      createdAt: now,
      metadata: userMessageMetadata,
    };

    if (projectId) {
      // Persist user message into project history for later reload.
      try {
        await touchProjectActivity(projectId);
        this.ensureExecutionActive(execution);
        // Update session activity timestamp so it appears at top of session list
        if (dbSessionId) {
          await touchSessionActivity(dbSessionId);
          this.ensureExecutionActive(execution);
        }
        await persistAgentMessage({
          projectId,
          role: 'user',
          messageType: 'chat',
          content: trimmed,
          sessionId,
          cliSource: engineName,
          requestId,
          id: userMessage.id,
          createdAt: userMessage.createdAt,
          metadata: userMessageMetadata,
          upsertById: true,
        });
        this.ensureExecutionActive(execution);
      } catch (error) {
        console.error('[AgentChatService] Failed to persist user message:', error);
        if (savedAttachments.length > 0) {
          await this.rollbackAttachments(projectId, savedAttachments);
          throw new Error(
            `Failed to persist message attachments: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        throw new Error(
          `Failed to persist user message: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.ensureExecutionActive(execution);

    this.streamManager.publish({ type: 'message', data: userMessage });

    this.streamManager.publish({
      type: 'status',
      data: {
        sessionId,
        status: 'starting',
        requestId,
        message: 'Agent request accepted',
      },
    });

    execution.engineName = engineName;

    const ctx: EngineExecutionContext = {
      emit: (event: RealtimeEvent) => {
        if (!this.isExecutionCurrent(execution)) {
          return;
        }
        this.streamManager.publish(event);

        if (!projectId) {
          return;
        }

        if (event.type === 'message') {
          const msg = event.data;
          if (!msg) return;

          // Only persist final snapshots; streaming deltas are transient.
          if (msg.isStreaming && !msg.isFinal) {
            return;
          }

          // User messages are already handled above.
          if (msg.role === 'user') {
            return;
          }

          const content = msg.content?.trim();
          if (!content) {
            return;
          }

          const persistedSessionId =
            typeof msg.sessionId === 'string' && msg.sessionId.trim().length > 0
              ? msg.sessionId
              : sessionId;
          const persistedRequestId =
            typeof msg.requestId === 'string' && msg.requestId.trim().length > 0
              ? msg.requestId
              : requestId;

          if (
            persistedSessionId !== execution.sessionId ||
            persistedRequestId !== execution.requestId ||
            !this.isExecutionCurrent(execution)
          ) {
            return;
          }

          this.trackPersistence(
            execution,
            persistAgentMessage({
              projectId,
              role: msg.role,
              messageType: msg.messageType,
              content,
              metadata: msg.metadata,
              sessionId: persistedSessionId,
              conversationId: undefined,
              cliSource: msg.cliSource,
              requestId: persistedRequestId,
              id: msg.id,
              createdAt: msg.createdAt,
              upsertById: true,
            }).then(() => undefined),
          );
        }
      },
      // Callback to persist Claude session ID when SDK returns system/init message
      // Prefer session-level persistence over project-level
      persistClaudeSessionId: dbSessionId
        ? async (claudeSessionId: string) => {
            if (this.isExecutionCurrent(execution)) {
              await updateEngineSessionId(dbSessionId, claudeSessionId);
            }
          }
        : projectId
          ? async (claudeSessionId: string) => {
              if (this.isExecutionCurrent(execution)) {
                await updateProjectClaudeSessionId(projectId, claudeSessionId);
              }
            }
          : undefined,
      // Callback to persist management info from system:init message
      // Only available when using session-level persistence
      persistManagementInfo: dbSessionId
        ? async (info) => {
            if (this.isExecutionCurrent(execution)) {
              await updateManagementInfo(dbSessionId, info);
            }
          }
        : undefined,
    };

    const engineOptions: EngineInitOptions = {
      sessionId,
      instruction: engineInstruction,
      model: effectiveModel,
      projectRoot,
      requestId,
      // Pass original attachments (for fallback) and resolved paths (preferred)
      attachments: payload.attachments,
      resolvedImagePaths,
      projectId,
      dbSessionId,
      // Session-level configuration for ClaudeEngine
      permissionMode: dbSession?.permissionMode,
      allowDangerouslySkipPermissions: dbSession?.allowDangerouslySkipPermissions,
      systemPromptConfig: dbSession?.systemPromptConfig,
      optionsConfig: dbSession?.optionsConfig,
      // Pass Claude session ID for session resumption (ClaudeEngine only)
      resumeClaudeSessionId: engineName === 'claude' ? resumeClaudeSessionId : undefined,
      // Pass Codex-specific configuration (CodexEngine only)
      codexConfig: engineName === 'codex' ? dbSession?.optionsConfig?.codexConfig : undefined,
    };

    this.ensureExecutionActive(execution);
    execution.phase = 'running';

    // Fire-and-forget execution to keep HTTP handler fast.
    void this.runEngine(engine, engineOptions, ctx, execution);

    return { requestId };
  }

  /**
   * Cancel a running execution by requestId.
   * Returns true if the execution was found and cancelled, false otherwise.
   */
  cancelExecution(sessionId: string, requestId: string): boolean {
    const key = executionKey(sessionId, requestId);
    const execution = this.runningExecutions.get(key);
    if (!execution || execution.cancelled) {
      return false;
    }

    // Keep an identity tombstone until the old engine settles. This prevents
    // immediate requestId reuse from being confused with late events/finally.
    this.cancelExecutionRecord(execution);

    // Emit cancelled status
    this.streamManager.publish({
      type: 'status',
      data: {
        sessionId: execution.sessionId,
        status: 'cancelled',
        requestId,
        message: 'Execution cancelled by user',
      },
    });

    return true;
  }

  /**
   * Cancel all running executions for a session.
   * Returns the number of executions cancelled.
   */
  cancelSessionExecutions(sessionId: string): number {
    let cancelled = 0;
    for (const execution of this.runningExecutions.values()) {
      if (this.executionMatchesSession(execution, sessionId) && !execution.cancelled) {
        this.cancelExecutionRecord(execution);
        cancelled++;
      }
    }

    if (cancelled > 0) {
      this.streamManager.publish({
        type: 'status',
        data: {
          sessionId,
          status: 'cancelled',
          message: `Cancelled ${cancelled} running execution(s)`,
        },
      });
    }

    return cancelled;
  }

  /**
   * Cancel every running execution during server shutdown.
   * Returns the number of executions that were newly cancelled.
   */
  cancelAllExecutions(): number {
    const sessionIds = new Set<string>();
    for (const execution of this.runningExecutions.values()) {
      if (!execution.cancelled) {
        sessionIds.add(execution.sessionId);
      }
    }

    let cancelled = 0;
    for (const sessionId of sessionIds) {
      cancelled += this.cancelSessionExecutions(sessionId);
    }
    return cancelled;
  }

  /**
   * Hold a session tombstone while destructive session state is changed.
   * Preparation, engine execution, and spawned persistence must all settle first.
   */
  async withSessionLifecycleMutation<T>(
    sessionId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    if (this.mutatingSessions.has(sessionId)) {
      throw new Error(`Session lifecycle mutation already in progress: ${sessionId}`);
    }

    this.mutatingSessions.add(sessionId);
    try {
      await this.cancelAndAwaitExecutions((execution) =>
        this.executionMatchesSession(execution, sessionId),
      );
      return await mutation();
    } finally {
      this.mutatingSessions.delete(sessionId);
    }
  }

  /**
   * Hold a project tombstone while destructive project state is changed.
   * Session ids are resolved under the tombstone so session-only requests cannot escape it.
   */
  async withProjectLifecycleMutation<T>(
    projectId: string,
    resolveSessionIds: () => Promise<string[]>,
    mutation: () => Promise<T>,
  ): Promise<T> {
    if (this.mutatingProjects.has(projectId)) {
      throw new Error(`Project lifecycle mutation already in progress: ${projectId}`);
    }

    this.mutatingProjects.add(projectId);
    const unresolvedScopes = Array.from(this.runningExecutions.values())
      .filter((execution) => !execution.scopeResolved)
      .map((execution) => execution.scopeReady);
    const protectedSessionIds: string[] = [];

    try {
      const [sessionIds] = await Promise.all([
        resolveSessionIds(),
        Promise.allSettled(unresolvedScopes),
      ]);
      const uniqueSessionIds = Array.from(new Set(sessionIds.filter(Boolean)));
      for (const sessionId of uniqueSessionIds) {
        if (this.mutatingSessions.has(sessionId)) {
          throw new Error(`Session lifecycle mutation already in progress: ${sessionId}`);
        }
        this.mutatingSessions.add(sessionId);
        protectedSessionIds.push(sessionId);
      }

      const sessionIdSet = new Set(uniqueSessionIds);
      await this.cancelAndAwaitExecutions(
        (execution) =>
          execution.projectId === projectId ||
          sessionIdSet.has(execution.sessionId) ||
          (execution.dbSessionId !== undefined && sessionIdSet.has(execution.dbSessionId)),
      );
      return await mutation();
    } finally {
      for (const sessionId of protectedSessionIds) {
        this.mutatingSessions.delete(sessionId);
      }
      this.mutatingProjects.delete(projectId);
    }
  }

  /**
   * Get list of running executions for diagnostics.
   */
  getRunningExecutions(): RunningExecution[] {
    return Array.from(this.runningExecutions.values()).filter(
      (execution) => !execution.cancelled && execution.phase !== 'settled',
    );
  }

  private resolveEngineName(preference?: EngineName, projectPreferredCli?: EngineName): EngineName {
    if (preference && this.engines.has(preference)) {
      return preference;
    }
    if (projectPreferredCli && this.engines.has(projectPreferredCli)) {
      return projectPreferredCli;
    }
    return this.defaultEngineName;
  }

  private isExecutionCurrent(execution: ExecutionRecord): boolean {
    return (
      !execution.cancelled &&
      execution.phase !== 'settled' &&
      !this.isExecutionScopeMutating(execution) &&
      this.runningExecutions.get(executionKey(execution.sessionId, execution.requestId)) ===
        execution
    );
  }

  private async rollbackAttachments(
    projectId: string,
    attachments: SavedAttachment[],
  ): Promise<void> {
    const results = await Promise.allSettled(
      attachments.map((attachment) =>
        attachmentService.deleteAttachment(projectId, attachment.filename),
      ),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[AgentChatService] Failed to roll back attachment:', result.reason);
      }
    }
  }

  private reserveExecution(
    sessionId: string,
    requestId: string,
    payload: AgentActRequest,
  ): ExecutionRecord {
    const key = executionKey(sessionId, requestId);
    if (this.runningExecutions.has(key)) {
      throw new Error('requestId is already active for this session');
    }

    const projectId =
      typeof payload.projectId === 'string' && payload.projectId.trim().length > 0
        ? payload.projectId.trim()
        : undefined;
    const dbSessionId =
      typeof payload.dbSessionId === 'string' && payload.dbSessionId.trim().length > 0
        ? payload.dbSessionId.trim()
        : undefined;
    this.assertLifecycleAllowsExecution(sessionId, dbSessionId, projectId);
    this.assertExecutionCapacity(sessionId, dbSessionId, projectId);

    let resolveScopeReady!: () => void;
    const scopeReady = new Promise<void>((resolve) => {
      resolveScopeReady = resolve;
    });
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });

    const execution: ExecutionRecord = {
      requestId,
      sessionId,
      engineName: this.defaultEngineName,
      projectId,
      dbSessionId,
      abortController: new AbortController(),
      startedAt: new Date(),
      settled,
      cancelled: false,
      phase: 'preparing',
      scopeReady,
      resolveScopeReady,
      resolveSettled,
      scopeResolved: projectId !== undefined,
      pendingPersistence: new Set(),
    };

    this.runningExecutions.set(key, execution);
    if (execution.scopeResolved) {
      execution.resolveScopeReady();
    }
    return execution;
  }

  private assertLifecycleAllowsExecution(
    sessionId: string,
    dbSessionId: string | undefined,
    projectId: string | undefined,
  ): void {
    if (
      this.mutatingSessions.has(sessionId) ||
      (dbSessionId !== undefined && this.mutatingSessions.has(dbSessionId))
    ) {
      throw new Error('Session lifecycle mutation in progress');
    }
    if (projectId !== undefined && this.mutatingProjects.has(projectId)) {
      throw new Error('Project lifecycle mutation in progress');
    }
    // A session-only request cannot prove that it belongs to a different project yet.
    if (projectId === undefined && this.mutatingProjects.size > 0) {
      throw new Error('Project lifecycle mutation in progress');
    }
  }

  private assertExecutionCapacity(
    sessionId: string,
    dbSessionId: string | undefined,
    projectId: string | undefined,
    excluded?: ExecutionRecord,
  ): void {
    let globalCount = 0;
    let sessionCount = 0;
    let projectCount = 0;
    for (const execution of this.runningExecutions.values()) {
      if (execution === excluded || execution.phase === 'settled') continue;
      globalCount += 1;
      if (
        execution.sessionId === sessionId ||
        execution.dbSessionId === sessionId ||
        (dbSessionId !== undefined &&
          (execution.sessionId === dbSessionId || execution.dbSessionId === dbSessionId))
      ) {
        sessionCount += 1;
      }
      if (projectId !== undefined && execution.projectId === projectId) {
        projectCount += 1;
      }
    }

    if (globalCount >= AGENT_EXECUTION_LIMITS.maxGlobal) {
      throw new Error(
        `Agent execution capacity reached (${AGENT_EXECUTION_LIMITS.maxGlobal} global)`,
      );
    }
    if (sessionCount >= AGENT_EXECUTION_LIMITS.maxPerSession) {
      throw new Error(
        `Agent session execution capacity reached (${AGENT_EXECUTION_LIMITS.maxPerSession})`,
      );
    }
    if (projectId !== undefined && projectCount >= AGENT_EXECUTION_LIMITS.maxPerProject) {
      throw new Error(
        `Agent project execution capacity reached (${AGENT_EXECUTION_LIMITS.maxPerProject})`,
      );
    }
  }

  private associateExecutionProject(execution: ExecutionRecord, projectId: string): void {
    if (execution.projectId !== projectId) {
      this.assertExecutionCapacity(
        execution.sessionId,
        execution.dbSessionId,
        projectId,
        execution,
      );
    }
    execution.projectId = projectId;
    if (!execution.scopeResolved) {
      execution.scopeResolved = true;
      execution.resolveScopeReady();
    }
    this.ensureExecutionActive(execution);
  }

  private ensureExecutionActive(execution: ExecutionRecord): void {
    if (
      execution.cancelled ||
      execution.abortController.signal.aborted ||
      execution.phase === 'settled'
    ) {
      throw new Error('Execution cancelled during preparation');
    }
    if (this.isExecutionScopeMutating(execution)) {
      this.cancelExecutionRecord(execution);
      throw new Error('Execution scope lifecycle mutation in progress');
    }
  }

  private isExecutionScopeMutating(execution: ExecutionRecord): boolean {
    return (
      this.mutatingSessions.has(execution.sessionId) ||
      (execution.dbSessionId !== undefined && this.mutatingSessions.has(execution.dbSessionId)) ||
      (execution.projectId !== undefined && this.mutatingProjects.has(execution.projectId))
    );
  }

  private executionMatchesSession(execution: ExecutionRecord, sessionId: string): boolean {
    return execution.sessionId === sessionId || execution.dbSessionId === sessionId;
  }

  private cancelExecutionRecord(execution: ExecutionRecord): void {
    if (execution.cancelled) {
      return;
    }
    execution.cancelled = true;
    execution.abortController.abort();
  }

  private async cancelAndAwaitExecutions(
    predicate: (execution: ExecutionRecord) => boolean,
  ): Promise<number> {
    const executions = Array.from(this.runningExecutions.values()).filter(predicate);
    let cancelled = 0;
    const cancelledBySession = new Map<string, number>();
    for (const execution of executions) {
      if (!execution.cancelled) {
        this.cancelExecutionRecord(execution);
        cancelled++;
        cancelledBySession.set(
          execution.sessionId,
          (cancelledBySession.get(execution.sessionId) ?? 0) + 1,
        );
      }
    }
    for (const [sessionId, count] of cancelledBySession) {
      this.streamManager.publish({
        type: 'status',
        data: {
          sessionId,
          status: 'cancelled',
          message: `Cancelled ${count} running execution(s)`,
        },
      });
    }
    await Promise.all(executions.map((execution) => execution.settled));
    return cancelled;
  }

  private trackPersistence(execution: ExecutionRecord, operation: Promise<void>): void {
    const tracked = operation.catch((error) => {
      console.error('[AgentChatService] Failed to persist agent message:', error);
    });
    execution.pendingPersistence.add(tracked);
    void tracked.finally(() => {
      execution.pendingPersistence.delete(tracked);
    });
  }

  private async settleExecution(execution: ExecutionRecord): Promise<void> {
    if (execution.phase === 'settled') {
      return;
    }
    if (execution.settling) {
      return execution.settling;
    }

    execution.settling = (async () => {
      if (!execution.scopeResolved) {
        execution.scopeResolved = true;
        execution.resolveScopeReady();
      }
      while (execution.pendingPersistence.size > 0) {
        await Promise.all(Array.from(execution.pendingPersistence));
      }
      execution.phase = 'settled';
      const key = executionKey(execution.sessionId, execution.requestId);
      if (this.runningExecutions.get(key) === execution) {
        this.runningExecutions.delete(key);
      }
      execution.resolveSettled();
    })();

    return execution.settling;
  }

  private async runEngine(
    engine: AgentEngine,
    options: EngineInitOptions,
    ctx: EngineExecutionContext,
    execution: ExecutionRecord,
  ): Promise<void> {
    const { sessionId, requestId, abortController } = execution;
    try {
      // Check if already aborted before starting
      if (!this.isExecutionCurrent(execution)) {
        return;
      }

      this.streamManager.publish({
        type: 'status',
        data: {
          sessionId,
          status: 'running',
          requestId,
        },
      });

      // Pass abort signal to engine
      const optionsWithSignal: EngineInitOptions = {
        ...options,
        signal: abortController.signal,
      };

      await engine.initializeAndRun(optionsWithSignal, ctx);

      // Only emit completed if not aborted
      if (this.isExecutionCurrent(execution)) {
        this.streamManager.publish({
          type: 'status',
          data: {
            sessionId,
            status: 'completed',
            requestId,
          },
        });
      }
    } catch (error) {
      // Check if this was an abort error
      if (!this.isExecutionCurrent(execution)) {
        // Already handled by cancelExecution, just return
        return;
      }

      const message = error instanceof Error ? error.message : String(error);

      this.streamManager.publish({
        type: 'error',
        error: message,
        data: { sessionId, requestId },
      });

      this.streamManager.publish({
        type: 'status',
        data: {
          sessionId,
          status: 'error',
          message,
          requestId,
        },
      });
    } finally {
      await this.settleExecution(execution);
    }
  }

  /**
   * Expose registered engines for UI and diagnostics.
   */
  getEngineInfos(): Array<{ name: EngineName; supportsMcp?: boolean }> {
    const result: Array<{ name: EngineName; supportsMcp?: boolean }> = [];
    for (const engine of this.engines.values()) {
      result.push({
        name: engine.name,
        supportsMcp: engine.supportsMcp,
      });
    }
    return result;
  }
}
