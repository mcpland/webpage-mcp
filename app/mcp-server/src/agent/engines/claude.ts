import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  AGENT_SESSION_MAX_THINKING_TOKENS,
  AGENT_SESSION_MAX_TURNS,
  DEFAULT_MCP_INSTANCE_ID,
} from 'webpage-mcp-shared';
import type { AgentEngine, EngineExecutionContext, EngineInitOptions } from './types';
import type { AgentMessage, RealtimeEvent } from '../types';
import { getProject } from '../project-service';
import { resolveClaudePermissionSettings } from '../session-security';
import { resolveWebpageMcpStdioConfig } from './mcp-stdio-config';
import { createAgentEventDedupKey } from './event-dedupe';
import {
  linkAbortSignal,
  resolveClaudeEngineTimeoutMs,
  spawnSupervisedClaudeCodeProcess,
  type SupervisedClaudeCodeProcess,
} from './claude-process';
import {
  BoundedAssistantStream,
  BoundedMap,
  BoundedSet,
  BoundedTextAccumulator,
  STREAM_ASSISTANT_TEXT_MAX_BYTES,
  STREAM_DEDUPE_MAX_ENTRIES,
  STREAM_PENDING_TOOL_INPUT_MAX_BYTES,
  STREAM_PENDING_TOOL_MAX_ENTRIES,
  STREAM_THINKING_TEXT_MAX_BYTES,
  STREAM_TOOL_FIELD_MAX_BYTES,
  boundStreamText,
  createBoundedAgentMessage,
  type AssistantStreamSnapshot,
  type BoundedTextSnapshot,
} from './stream-output';
import {
  CLAUDE_EVENT_ERROR_MAX_BYTES,
  CLAUDE_TOOL_ID_MAX_BYTES,
  boundClaudeEventText,
  buildBoundedClaudeAuthStatus,
  buildBoundedClaudeManagementInfo,
  buildBoundedClaudeResultError,
  buildBoundedClaudeToolMetadata,
  extractBoundedClaudeMessageContent,
  extractBoundedClaudeToolResultContent,
  parseBoundedClaudeSessionId,
  pickBoundedClaudeIdentifier,
  pickBoundedClaudeString,
} from './claude-event-bounds';
import {
  removePrivateTempAttachment,
  writePrivateTempAttachment,
} from './private-temp-attachment';
import {
  BoundedDiagnosticBuffer,
  DIAGNOSTIC_ERROR_MAX_BYTES,
  createRedactedDiagnosticError,
  redactDiagnosticText,
} from './diagnostic-redaction';

export function describeClaudeAuthTokenConfiguration(
  authToken: string | undefined,
): string | null {
  return authToken ? '[ClaudeEngine] ANTHROPIC_AUTH_TOKEN is configured' : null;
}

export function describeClaudeBaseUrlConfiguration(
  baseUrl: string | undefined,
): string | null {
  return baseUrl ? '[ClaudeEngine] ANTHROPIC_BASE_URL is configured' : null;
}

export function validateClaudeExecutionOptionsConfig(optionsConfig: unknown): void {
  if (optionsConfig === undefined || optionsConfig === null) return;
  if (typeof optionsConfig !== 'object' || Array.isArray(optionsConfig)) {
    throw new Error('ClaudeEngine: optionsConfig must be an object');
  }
  const record = optionsConfig as Record<string, unknown>;
  for (const [field, maximum] of [
    ['maxTurns', AGENT_SESSION_MAX_TURNS],
    ['maxThinkingTokens', AGENT_SESSION_MAX_THINKING_TOKENS],
  ] as const) {
    const value = record[field];
    if (
      value !== undefined &&
      (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum)
    ) {
      throw new Error(
        `ClaudeEngine: optionsConfig.${field} must be a positive integer no greater than ${maximum}`,
      );
    }
  }
}

export function classifyClaudeDiagnosticError(
  message: unknown,
  stderrLines: readonly string[],
): string {
  const safeMessage = redactDiagnosticText(message, CLAUDE_EVENT_ERROR_MAX_BYTES);
  const usefulStderr: string[] = [];
  let scanned = 0;
  for (
    let index = stderrLines.length - 1;
    index >= 0 && usefulStderr.length < 3 && scanned < 16;
    index -= 1
  ) {
    scanned += 1;
    const line = redactDiagnosticText(stderrLines[index]).trim();
    if (line && !line.includes('Spawning Claude Code:')) {
      usefulStderr.unshift(line);
    }
  }
  return redactDiagnosticText(
    usefulStderr.length > 0
      ? `${safeMessage} (stderr: ${usefulStderr.join(' | ')})`
      : safeMessage,
    CLAUDE_EVENT_ERROR_MAX_BYTES,
  );
}

/**
 * Resolve the Claude SDK filesystem setting sources without trusting the repository.
 *
 * Project and local sources can load repository-controlled `.claude/settings*.json`
 * files, including command hooks. Until the application has a persisted project
 * trust decision, keep them disabled. A user's global settings may be loaded only
 * when the session explicitly opts in to the `user` source.
 */
export function resolveClaudeSettingSources(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.includes('user') ? ['user'] : [];
}

const CLAUDE_TOOL_LOG_NAME_MAX_BYTES = 256;

export interface ParsedClaudeToolInput {
  input: Record<string, unknown>;
  logMessage: string;
}

/** Parse streamed tool input while keeping its persisted diagnostic log metadata-only. */
export function parseClaudeToolInputForEvent(
  toolName: unknown,
  snapshot: BoundedTextSnapshot,
): ParsedClaudeToolInput {
  let input: Record<string, unknown> = {};
  let parseStatus: 'empty' | 'invalid' | 'parsed' | 'skipped-truncated' = snapshot.truncated
    ? 'skipped-truncated'
    : 'empty';

  if (snapshot.text && !snapshot.truncated) {
    try {
      input = JSON.parse(snapshot.text) as Record<string, unknown>;
      parseStatus = 'parsed';
    } catch {
      // JSON parse errors can echo the input near the failure position. Do not log them.
      parseStatus = 'invalid';
    }
  }

  const originalBytes =
    Number.isSafeInteger(snapshot.originalBytes) && snapshot.originalBytes >= 0
      ? snapshot.originalBytes
      : 0;
  const retainedBytes =
    Number.isSafeInteger(snapshot.retainedBytes) && snapshot.retainedBytes >= 0
      ? snapshot.retainedBytes
      : 0;
  const boundedToolName = redactDiagnosticText(toolName, CLAUDE_TOOL_LOG_NAME_MAX_BYTES);

  return {
    input,
    logMessage:
      `[ClaudeEngine] content_block_stop - toolName: ${boundedToolName}, ` +
      `inputBytes: ${originalBytes}, retainedBytes: ${retainedBytes}, ` +
      `truncated: ${snapshot.truncated}, parseStatus: ${parseStatus}`,
  };
}

// Images are provided to Claude Code via local file paths referenced in the prompt text.
// Claude Code CLI reads images from local paths, so we write base64 images to temp files and reference them.

/**
 * Tool action type for categorizing tool operations.
 */
type ToolAction = 'Edited' | 'Created' | 'Read' | 'Deleted' | 'Generated' | 'Searched' | 'Executed';

/**
 * Map of tool names to their corresponding actions.
 */
const TOOL_NAME_ACTION_MAP: Record<string, ToolAction> = {
  read: 'Read',
  read_file: 'Read',
  write: 'Created',
  write_file: 'Created',
  create_file: 'Created',
  edit: 'Edited',
  edit_file: 'Edited',
  apply_patch: 'Edited',
  patch_file: 'Edited',
  remove_file: 'Deleted',
  delete_file: 'Deleted',
  list_files: 'Searched',
  glob: 'Searched',
  glob_files: 'Searched',
  search_files: 'Searched',
  grep: 'Searched',
  bash: 'Executed',
  run: 'Executed',
  shell: 'Executed',
  todo_write: 'Generated',
  plan_write: 'Generated',
};

/**
 * ClaudeEngine integrates the Claude Agent SDK as an AgentEngine implementation.
 *
 * This engine uses the @anthropic-ai/claude-agent-sdk to interact with Claude,
 * streaming events back to the sidepanel UI via RealtimeEvent envelopes.
 */
export class ClaudeEngine implements AgentEngine {
  public readonly name = 'claude' as const;
  public readonly supportsMcp = true;

  constructor(public readonly instanceId = DEFAULT_MCP_INSTANCE_ID) {}

  async initializeAndRun(options: EngineInitOptions, ctx: EngineExecutionContext): Promise<void> {
    const {
      sessionId,
      instruction,
      model,
      projectRoot,
      requestId,
      signal,
      attachments,
      resolvedImagePaths,
      projectId,
      permissionMode,
      allowDangerouslySkipPermissions,
      systemPromptConfig,
      optionsConfig,
      resumeClaudeSessionId,
    } = options;
    validateClaudeExecutionOptionsConfig(optionsConfig);
    const repoPath = this.resolveRepoPath(projectRoot);

    // Check if already aborted
    if (signal?.aborted) {
      throw new Error('ClaudeEngine: execution was cancelled');
    }

    const normalizedInstruction = instruction.trim();
    if (!normalizedInstruction) {
      throw new Error('ClaudeEngine: instruction must not be empty');
    }

    // Dynamically import the Claude Agent SDK
    // Images are passed via temp file paths appended to the prompt string
    let query: (args: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<any>;
    try {
      // Dynamic import to avoid hard dependency - install @anthropic-ai/claude-agent-sdk to use this engine
      // Use string variable to bypass TypeScript module resolution
      const sdkModuleName = '@anthropic-ai/claude-agent-sdk';

      const sdk = await (Function(
        'moduleName',
        'return import(moduleName)',
      )(sdkModuleName) as Promise<any>);
      query = sdk.query;
    } catch (error) {
      const message = redactDiagnosticText(error, DIAGNOSTIC_ERROR_MAX_BYTES);
      throw createRedactedDiagnosticError(
        `ClaudeEngine: Failed to load Claude Agent SDK. Please install @anthropic-ai/claude-agent-sdk. Error: ${message}`,
        CLAUDE_EVENT_ERROR_MAX_BYTES,
      );
    }

    // Resolve model
    const resolvedModel =
      model?.trim() || process.env.CLAUDE_DEFAULT_MODEL || 'claude-sonnet-4-20250514';

    // State management
    const stderrDiagnostics = new BoundedDiagnosticBuffer();
    const logStderrLines = (lines: string[]): void => {
      for (const line of lines) {
        console.error(`[ClaudeEngine][stderr] ${line}`);
      }
    };
    const flushStderr = (): void => {
      logStderrLines(stderrDiagnostics.flush());
    };
    const recordStderr = (data: string): void => {
      logStderrLines(stderrDiagnostics.push(data));
    };
    let assistantMessageId: string | null = null;
    let assistantCreatedAt: string | null = null;
    let lastAssistantEmitted: { content: string; isFinal: boolean } | null = null;
    const streamedToolHashes = new BoundedSet<string>(STREAM_DEDUPE_MAX_ENTRIES);

    // Tool input accumulation for streaming tool_use blocks
    // Key: content block index, Value: { toolName, toolId, inputJson }
    const pendingToolInputs = new BoundedMap<
      number,
      { toolName: string; toolId: string; inputJson: BoundedTextAccumulator }
    >(STREAM_PENDING_TOOL_MAX_ENTRIES);
    let currentContentBlockIndex = -1;

    /**
     * Emit assistant message to the stream.
     * Includes deduplication to prevent multiple identical final emissions.
     */
    const emitAssistantSnapshot = (
      snapshot: AssistantStreamSnapshot,
      isFinal: boolean,
    ): void => {
      const content = snapshot.content;
      if (!content) return;

      // Deduplicate: skip if same content and isFinal state was already emitted
      if (
        lastAssistantEmitted &&
        lastAssistantEmitted.content === content &&
        lastAssistantEmitted.isFinal === isFinal
      ) {
        return;
      }
      lastAssistantEmitted = { content, isFinal };

      if (!assistantMessageId) {
        assistantMessageId = randomUUID();
      }
      if (!assistantCreatedAt) {
        assistantCreatedAt = new Date().toISOString();
      }

      const message = createBoundedAgentMessage(
        {
          id: assistantMessageId,
          sessionId,
          role: 'assistant',
          content,
          messageType: 'chat',
          cliSource: this.name,
          requestId,
          isStreaming: !isFinal,
          isFinal,
          createdAt: assistantCreatedAt,
        },
        {
          contentMaximumBytes:
            STREAM_ASSISTANT_TEXT_MAX_BYTES + STREAM_THINKING_TEXT_MAX_BYTES,
          truncation: snapshot.truncation,
        },
      );

      ctx.emit({ type: 'message', data: message });
    };

    const assistantStream = new BoundedAssistantStream(emitAssistantSnapshot);

    const emitAssistant = (isFinal: boolean): void => {
      if (isFinal) assistantStream.flushFinal();
    };

    /**
     * Emit tool message with deduplication.
     */
    const dispatchToolMessage = (
      content: string,
      metadata: Record<string, unknown>,
      messageType: 'tool_use' | 'tool_result',
      isStreaming: boolean,
    ): void => {
      const trimmed = content.trim();
      if (!trimmed) return;

      const message = createBoundedAgentMessage({
        id: randomUUID(),
        sessionId,
        role: 'tool',
        content: trimmed,
        messageType,
        cliSource: this.name,
        requestId,
        isStreaming,
        isFinal: !isStreaming,
        createdAt: new Date().toISOString(),
        metadata: { cli_type: 'claude', ...metadata },
      });
      const hash = createAgentEventDedupKey(
        `${messageType}:${message.content}:${JSON.stringify(message.metadata)}:${sessionId}:${requestId || ''}`,
      );
      if (streamedToolHashes.has(hash)) return;
      streamedToolHashes.add(hash);

      ctx.emit({ type: 'message', data: message });
    };

    /**
     * Infer tool action from tool name.
     */
    const inferActionFromToolName = (toolName: unknown): ToolAction | undefined => {
      if (typeof toolName !== 'string') return undefined;
      const normalized = toolName.trim().toLowerCase();
      if (!normalized) return undefined;

      if (TOOL_NAME_ACTION_MAP[normalized]) {
        return TOOL_NAME_ACTION_MAP[normalized];
      }

      // Try suffix after colon (e.g., "mcp__server__tool" -> "tool")
      const suffix = normalized.split(':').pop() ?? normalized;
      if (suffix && TOOL_NAME_ACTION_MAP[suffix]) {
        return TOOL_NAME_ACTION_MAP[suffix];
      }

      // Infer from name patterns
      if (
        normalized.includes('edit') ||
        normalized.includes('modify') ||
        normalized.includes('patch')
      ) {
        return 'Edited';
      }
      if (normalized.includes('write') || normalized.includes('create')) {
        return 'Created';
      }
      if (normalized.includes('read') || normalized.includes('view')) {
        return 'Read';
      }
      if (normalized.includes('delete') || normalized.includes('remove')) {
        return 'Deleted';
      }
      if (
        normalized.includes('search') ||
        normalized.includes('find') ||
        normalized.includes('glob') ||
        normalized.includes('grep')
      ) {
        return 'Searched';
      }
      if (
        normalized.includes('bash') ||
        normalized.includes('shell') ||
        normalized.includes('exec')
      ) {
        return 'Executed';
      }
      if (normalized.includes('todo') || normalized.includes('plan')) {
        return 'Generated';
      }

      return undefined;
    };

    /**
     * Build tool metadata from content block with detailed tool-specific information.
     */
    const buildToolMetadata = (contentBlock: Record<string, unknown>): Record<string, unknown> => {
      const toolName = this.pickFirstString(contentBlock.name) || 'unknown';
      const action = inferActionFromToolName(toolName);
      return buildBoundedClaudeToolMetadata(
        toolName,
        contentBlock.id,
        contentBlock.input,
        action,
      );
    };

    // State for temp file cleanup
    const tempFiles: string[] = [];
    let supervisedProcess: SupervisedClaudeCodeProcess | null = null;
    let processCompletionOutcome: Promise<{
      exit?: unknown;
      error?: Error;
    }> | null = null;
    let removeExternalAbortListener: (() => void) | null = null;
    let caughtExecutionError = false;
    let executionError: Error | null = null;
    let supervisedCompletionError: Error | null = null;
    const cleanupTempFiles = async (): Promise<void> => {
      if (tempFiles.length === 0) return;

      try {
        for (const filePath of tempFiles) {
          try {
            await removePrivateTempAttachment(filePath);
            console.error(
              redactDiagnosticText(`[ClaudeEngine] Cleaned up temp file: ${filePath}`),
            );
          } catch (err) {
            // Best-effort cleanup; ignore failures (file may already be deleted)
            console.error(
              redactDiagnosticText(
                `[ClaudeEngine] Failed to cleanup temp file ${filePath}: ${redactDiagnosticText(err)}`,
              ),
            );
          }
        }
      } catch (err) {
        console.error(
          `[ClaudeEngine] Failed to cleanup temp files: ${redactDiagnosticText(err)}`,
        );
      }
    };

    // Build prompt instruction (may be modified if images are attached)
    let promptInstruction = normalizedInstruction;

    try {
      // Use console.error for logging to avoid polluting stdout (Native Messaging protocol)
      console.error(
        `[ClaudeEngine] Starting query with model: ${redactDiagnosticText(resolvedModel)}`,
      );
      console.error(
        `[ClaudeEngine] Working directory: ${redactDiagnosticText(repoPath)}`,
      );

      // Check for image attachments - prefer resolvedImagePaths (persisted), fallback to temp files
      const hasResolvedPaths = resolvedImagePaths && resolvedImagePaths.length > 0;
      const imageAttachments = (attachments ?? []).filter((a) => a.type === 'image');
      const hasImages = hasResolvedPaths || imageAttachments.length > 0;

      if (hasImages) {
        // Strip any legacy "Image #N path:" lines to avoid duplicating references
        const instructionWithoutLegacyPaths = normalizedInstruction
          .replace(/\n*Image #\d+ path: [^\n]+/g, '')
          .trim();

        const imageLines: string[] = [];

        if (hasResolvedPaths) {
          // Use pre-resolved persistent paths (preferred - no temp files needed)
          console.error(
            `[ClaudeEngine] Using ${resolvedImagePaths.length} pre-resolved image path(s)`,
          );
          for (let index = 0; index < resolvedImagePaths.length; index++) {
            imageLines.push(`Image #${index + 1} path: ${resolvedImagePaths[index]}`);
          }
        } else {
          // Fallback: write base64 to temp files (legacy behavior)
          console.error(
            `[ClaudeEngine] Writing ${imageAttachments.length} image attachment(s) to temp files (fallback)`,
          );
          for (let index = 0; index < imageAttachments.length; index++) {
            const attachment = imageAttachments[index];
            const tempFilePath = await this.writeAttachmentToTemp(attachment);
            tempFiles.push(tempFilePath);
            imageLines.push(`Image #${index + 1} path: ${tempFilePath}`);
          }
        }

        // Build final instruction with image paths appended
        promptInstruction = [instructionWithoutLegacyPaths, imageLines.join('\n')]
          .filter((segment) => segment && segment.trim().length > 0)
          .join('\n\n')
          .trim();

        console.error(
          `[ClaudeEngine] Prepared prompt with ${imageLines.length} image path(s)`,
        );
      }

      // Start Claude Agent SDK query
      // Session resumption: if resumeClaudeSessionId is provided (from sessions.engineSessionId or legacy project),
      // pass it as 'resume' to continue a previous Claude conversation.
      // If not provided, SDK will create a new session.

      // SDK treats options.env as a complete replacement, so we must merge with process.env.
      const claudeEnv = await this.buildClaudeEnv();

      // Resolve permission settings without inferring the dangerous bypass acknowledgement.
      const {
        permissionMode: resolvedPermissionMode,
        allowDangerouslySkipPermissions: resolvedAllowDangerouslySkipPermissions,
      } = resolveClaudePermissionSettings(permissionMode, allowDangerouslySkipPermissions);

      // Parse optionsConfig for additional SDK options
      const optionsRecord =
        optionsConfig && typeof optionsConfig === 'object' && !Array.isArray(optionsConfig)
          ? (optionsConfig as Record<string, unknown>)
          : undefined;

      // Resolve project-scoped Webpage MCP toggle (default: enabled)
      const enableWebpageMcp = await (async (): Promise<boolean> => {
        if (!projectId) return true;
        try {
          const project = await getProject(projectId);
          return project?.enableWebpageMcp !== false;
        } catch (err) {
          const message = redactDiagnosticText(err);
          console.error(
            `[ClaudeEngine] Failed to load project enableWebpageMcp, defaulting to enabled: ${message}`,
          );
          return true;
        }
      })();

      // Fail closed: do not load repository-controlled settings or hooks. The
      // user's global settings are the only supported explicit filesystem source.
      const resolvedSettingSources = resolveClaudeSettingSources(optionsRecord?.settingSources);

      // Resolve system prompt from session config
      const resolvedSystemPrompt = (() => {
        if (typeof systemPromptConfig === 'string') {
          const trimmed = systemPromptConfig.trim();
          return trimmed.length > 0 ? trimmed : undefined;
        }
        if (
          !systemPromptConfig ||
          typeof systemPromptConfig !== 'object' ||
          Array.isArray(systemPromptConfig)
        ) {
          return undefined;
        }
        const record = systemPromptConfig as Record<string, unknown>;
        const type = record.type;
        if (type === 'custom' && typeof record.text === 'string') {
          const trimmed = record.text.trim();
          return trimmed.length > 0 ? trimmed : undefined;
        }
        if (type === 'preset' && record.preset === 'claude_code') {
          // Trim append and ignore empty strings to avoid "append is empty but object is passed" edge case
          const rawAppend = typeof record.append === 'string' ? record.append.trim() : '';
          const append = rawAppend.length > 0 ? rawAppend : undefined;
          return append
            ? { type: 'preset' as const, preset: 'claude_code' as const, append }
            : { type: 'preset' as const, preset: 'claude_code' as const };
        }
        return undefined;
      })();

      // The SDK owns this controller. The custom process supervisor listens to
      // the same signal, while the external listener is explicitly removed in
      // finally so completed executions cannot retain request state.
      const internalAbortController = new AbortController();
      removeExternalAbortListener = linkAbortSignal(signal, internalAbortController);

      const queryOptions: Record<string, unknown> = {
        cwd: repoPath,
        additionalDirectories: [repoPath],
        model: resolvedModel,
        // Permission settings are session-configurable and validated before SDK execution.
        permissionMode: resolvedPermissionMode,
        allowDangerouslySkipPermissions: resolvedAllowDangerouslySkipPermissions,
        // Enable streaming: emit stream_event with content_block_delta for real-time UI updates
        // Without this, SDK only outputs aggregated assistant/result messages
        includePartialMessages: true,
        // Empty by default. Project/local sources stay disabled until project trust exists.
        settingSources: resolvedSettingSources,
        // Custom system prompt if provided
        systemPrompt: resolvedSystemPrompt,
        // AbortController for cancellation support - SDK uses this to terminate underlying processes
        abortController: internalAbortController,
        // Pass merged env through to Claude SDK.
        env: claudeEnv,
        stderr: recordStderr,
        spawnClaudeCodeProcess: (
          spawnOptions: Parameters<typeof spawnSupervisedClaudeCodeProcess>[0],
        ) => {
          if (supervisedProcess) {
            throw new Error('ClaudeEngine: attempted to spawn Claude Code more than once');
          }
          supervisedProcess = spawnSupervisedClaudeCodeProcess(spawnOptions, {
            timeoutMs: resolveClaudeEngineTimeoutMs(),
            onStderr: recordStderr,
            // Timeout and SDK-requested termination must also unblock SDK
            // reads. Re-aborting is idempotent for external cancellation.
            onTerminationRequested: () => internalAbortController.abort(),
          });
          processCompletionOutcome = supervisedProcess.completion.then(
            (exit) => ({ exit }),
            (error: unknown) => ({
              error: createRedactedDiagnosticError(error),
            }),
          );
          return supervisedProcess.process;
        },
      };

      // Apply additional SDK options from optionsConfig
      if (optionsRecord) {
        const isStringArray = (value: unknown): value is string[] =>
          Array.isArray(value) && value.every((v) => typeof v === 'string');

        if (isStringArray(optionsRecord.allowedTools)) {
          queryOptions.allowedTools = optionsRecord.allowedTools;
        }
        if (isStringArray(optionsRecord.disallowedTools)) {
          queryOptions.disallowedTools = optionsRecord.disallowedTools;
        }

        const tools = optionsRecord.tools;
        if (isStringArray(tools)) {
          queryOptions.tools = tools;
        } else if (tools && typeof tools === 'object' && !Array.isArray(tools)) {
          const toolsRecord = tools as Record<string, unknown>;
          if (toolsRecord.type === 'preset' && toolsRecord.preset === 'claude_code') {
            queryOptions.tools = { type: 'preset', preset: 'claude_code' };
          }
        }

        if (isStringArray(optionsRecord.betas)) {
          queryOptions.betas = optionsRecord.betas;
        }

        if (
          typeof optionsRecord.maxThinkingTokens === 'number' &&
          Number.isFinite(optionsRecord.maxThinkingTokens)
        ) {
          queryOptions.maxThinkingTokens = optionsRecord.maxThinkingTokens;
        }
        if (typeof optionsRecord.maxTurns === 'number' && Number.isFinite(optionsRecord.maxTurns)) {
          queryOptions.maxTurns = optionsRecord.maxTurns;
        }
        if (
          typeof optionsRecord.maxBudgetUsd === 'number' &&
          Number.isFinite(optionsRecord.maxBudgetUsd)
        ) {
          queryOptions.maxBudgetUsd = optionsRecord.maxBudgetUsd;
        }

        if (
          optionsRecord.mcpServers &&
          typeof optionsRecord.mcpServers === 'object' &&
          !Array.isArray(optionsRecord.mcpServers)
        ) {
          queryOptions.mcpServers = optionsRecord.mcpServers;
        }
        if (
          optionsRecord.outputFormat &&
          typeof optionsRecord.outputFormat === 'object' &&
          !Array.isArray(optionsRecord.outputFormat)
        ) {
          queryOptions.outputFormat = optionsRecord.outputFormat;
        }
        if (typeof optionsRecord.enableFileCheckpointing === 'boolean') {
          queryOptions.enableFileCheckpointing = optionsRecord.enableFileCheckpointing;
        }
        if (
          optionsRecord.sandbox &&
          typeof optionsRecord.sandbox === 'object' &&
          !Array.isArray(optionsRecord.sandbox)
        ) {
          queryOptions.sandbox = optionsRecord.sandbox;
        }

        // Merge session-level env overrides with base claudeEnv
        // Session env takes precedence over process env (useful for per-session API keys, etc.)
        if (
          optionsRecord.env &&
          typeof optionsRecord.env === 'object' &&
          !Array.isArray(optionsRecord.env)
        ) {
          const sessionEnv = optionsRecord.env as Record<string, unknown>;
          const mergedEnv = { ...claudeEnv };
          for (const [key, value] of Object.entries(sessionEnv)) {
            if (typeof value === 'string') {
              mergedEnv[key] = value;
            }
          }
          // Ensure Node.js bin directory is still in PATH after merge
          // Session may have overwritten PATH, which would break child processes
          const nodeBinDir = path.dirname(process.execPath);
          const mergedPath = mergedEnv.PATH || mergedEnv.Path || '';
          if (!mergedPath.includes(nodeBinDir)) {
            mergedEnv.PATH = [nodeBinDir, mergedPath].filter(Boolean).join(path.delimiter);
          }
          queryOptions.env = mergedEnv;
        }
      }

      // Inject the local Webpage MCP server based on project preference.
      // This only controls the built-in "webpage-mcp" entry; user-configured MCP servers remain untouched.
      const WEBPAGE_MCP_SERVER_NAME = 'webpage-mcp';
      if (enableWebpageMcp) {
        const stdioConfig = resolveWebpageMcpStdioConfig(this.instanceId);
        const existingMcpServers =
          queryOptions.mcpServers &&
          typeof queryOptions.mcpServers === 'object' &&
          !Array.isArray(queryOptions.mcpServers)
            ? (queryOptions.mcpServers as Record<string, unknown>)
            : {};

        queryOptions.mcpServers = {
          ...existingMcpServers,
          [WEBPAGE_MCP_SERVER_NAME]: {
            type: 'stdio',
            command: stdioConfig.command,
            args: stdioConfig.args,
            ...(stdioConfig.env ? { env: stdioConfig.env } : {}),
          },
        };
        console.error(
          redactDiagnosticText(
            `[ClaudeEngine] Webpage MCP server enabled via stdio: ${stdioConfig.command} ${stdioConfig.args.join(' ')}`,
            DIAGNOSTIC_ERROR_MAX_BYTES,
          ),
        );
      } else if (
        queryOptions.mcpServers &&
        typeof queryOptions.mcpServers === 'object' &&
        !Array.isArray(queryOptions.mcpServers)
      ) {
        // If Webpage MCP is disabled, remove it from existing mcpServers if present
        const existing = queryOptions.mcpServers as Record<string, unknown>;
        if (WEBPAGE_MCP_SERVER_NAME in existing) {
          const { [WEBPAGE_MCP_SERVER_NAME]: _removed, ...rest } = existing;
          if (Object.keys(rest).length > 0) {
            queryOptions.mcpServers = rest;
          } else {
            delete (queryOptions as Record<string, unknown>).mcpServers;
          }
        }
        console.error('[ClaudeEngine] Webpage MCP server disabled');
      }

      // Add resume option if we have a valid Claude session ID
      if (resumeClaudeSessionId) {
        queryOptions.resume = resumeClaudeSessionId;
        console.error(
          `[ClaudeEngine] Resuming Claude session: ${redactDiagnosticText(resumeClaudeSessionId)}`,
        );
      }

      const response = query({
        prompt: promptInstruction,
        options: queryOptions,
      });

      // Process streaming response
      for await (const message of response) {
        // Check for cancellation before processing each message
        if (signal?.aborted) {
          console.error('[ClaudeEngine] Execution cancelled via abort signal');
          throw new Error('ClaudeEngine: execution was cancelled');
        }

        console.error(
          `[ClaudeEngine] Message type: ${redactDiagnosticText(message.type)}`,
        );

        if (message.type === 'stream_event') {
          const event = (message as unknown as { event?: Record<string, unknown> }).event ?? {};
          const eventType = this.pickFirstString(event.type);

          switch (eventType) {
            case 'message_start': {
              // Flush a prior message even if the SDK omitted message_stop,
              // then reset state for the new message.
              if (assistantStream.hasContent()) assistantStream.flushFinal();
              assistantStream.reset();
              pendingToolInputs.clear();
              assistantMessageId = randomUUID();
              assistantCreatedAt = new Date().toISOString();
              lastAssistantEmitted = null;
              break;
            }

            case 'content_block_start': {
              const contentBlock = event.content_block as Record<string, unknown> | undefined;
              const blockIndex =
                typeof event.index === 'number' ? event.index : ++currentContentBlockIndex;
              currentContentBlockIndex = blockIndex;

              if (contentBlock && contentBlock.type === 'tool_use') {
                const toolName = boundStreamText(
                  this.pickFirstString(contentBlock.name) || 'tool',
                  STREAM_TOOL_FIELD_MAX_BYTES,
                ).text;
                const toolId = boundStreamText(
                  pickBoundedClaudeIdentifier(contentBlock.id, CLAUDE_TOOL_ID_MAX_BYTES) || '',
                  CLAUDE_TOOL_ID_MAX_BYTES,
                ).text;

                // Store pending tool input for accumulation
                // Don't emit message here - wait for content_block_stop with complete input
                const evicted = pendingToolInputs.set(blockIndex, {
                  toolName,
                  toolId,
                  inputJson: new BoundedTextAccumulator(STREAM_PENDING_TOOL_INPUT_MAX_BYTES),
                });
                if (evicted) {
                  dispatchToolMessage(
                    `Using tool: ${evicted.value.toolName}\n\n… [tool input omitted]`,
                    {
                      toolName: evicted.value.toolName,
                      tool_name: evicted.value.toolName,
                      toolId: evicted.value.toolId,
                      truncated: true,
                      truncation: [
                        {
                          field: 'pendingTools',
                          originalEntries: pendingToolInputs.size + 1,
                          retainedEntries: pendingToolInputs.size,
                        },
                      ],
                    },
                    'tool_use',
                    false,
                  );
                }
              } else if (contentBlock && contentBlock.type === 'tool_result') {
                // Handle tool_result in content_block_start
                const metadata = this.buildToolResultMetadata(contentBlock);
                const extracted = extractBoundedClaudeToolResultContent(contentBlock);
                const content = extracted.content;
                if (extracted.truncated) {
                  metadata.truncated = true;
                  metadata.truncation = [{ field: 'toolResult' }];
                }
                const isError = contentBlock.is_error === true;

                dispatchToolMessage(
                  isError
                    ? `Error: ${content || 'Tool execution failed'}`
                    : content || 'Tool completed',
                  metadata,
                  'tool_result',
                  false,
                );
              }
              break;
            }

            case 'content_block_stop': {
              const blockIndex =
                typeof event.index === 'number' ? event.index : currentContentBlockIndex;

              // Check if we have accumulated tool input for this block
              if (pendingToolInputs.has(blockIndex)) {
                const pending = pendingToolInputs.get(blockIndex)!;
                pendingToolInputs.delete(blockIndex);

                const inputSnapshot = pending.inputJson.snapshot();
                const parsedToolInput = parseClaudeToolInputForEvent(
                  pending.toolName,
                  inputSnapshot,
                );
                const input = parsedToolInput.input;
                console.error(parsedToolInput.logMessage);

                // Build metadata with full input
                const metadata = buildToolMetadata({
                  name: pending.toolName,
                  id: pending.toolId,
                  input,
                });
                if (inputSnapshot.truncated) {
                  metadata.truncated = true;
                  metadata.truncation = [
                    {
                      field: 'toolInput',
                      originalBytes: inputSnapshot.originalBytes,
                      retainedBytes: inputSnapshot.retainedBytes,
                    },
                  ];
                }

                // Build informative content
                let content = `Using tool: ${pending.toolName}`;
                if (typeof metadata.command === 'string') {
                  content = `Running: ${metadata.command}`;
                } else if (typeof metadata.filePath === 'string') {
                  content = `Operating on: ${metadata.filePath}`;
                } else if (typeof metadata.pattern === 'string') {
                  content = `Searching: ${metadata.pattern}`;
                } else if (typeof input.query === 'string') {
                  content = `Searching: ${boundClaudeEventText(input.query).text}`;
                }

                // Emit final tool_use message with complete metadata
                dispatchToolMessage(
                  inputSnapshot.truncated ? `${content}\n\n… [tool input truncated]` : content,
                  metadata,
                  'tool_use',
                  false,
                );
              }

              // Check if this block was a tool_result
              const contentBlock = event.content_block as Record<string, unknown> | undefined;
              if (contentBlock && contentBlock.type === 'tool_result') {
                const metadata = this.buildToolResultMetadata(contentBlock);
                const extracted = extractBoundedClaudeToolResultContent(contentBlock);
                const content = extracted.content;
                if (extracted.truncated) {
                  metadata.truncated = true;
                  metadata.truncation = [{ field: 'toolResult' }];
                }
                const isError = contentBlock.is_error === true;

                dispatchToolMessage(
                  isError
                    ? `Error: ${content || 'Tool execution failed'}`
                    : content || 'Tool completed',
                  metadata,
                  'tool_result',
                  false,
                );
              }
              break;
            }

            case 'content_block_delta': {
              const delta = event.delta as Record<string, unknown> | string | undefined;
              const blockIndex =
                typeof event.index === 'number' ? event.index : currentContentBlockIndex;

              // Check if this is a tool_use input_json_delta
              if (delta && typeof delta === 'object' && delta.type === 'input_json_delta') {
                const partialJson = delta.partial_json as string | undefined;
                if (partialJson && pendingToolInputs.has(blockIndex)) {
                  const boundedPartial = boundClaudeEventText(
                    partialJson,
                    STREAM_PENDING_TOOL_INPUT_MAX_BYTES,
                  );
                  const accumulator = pendingToolInputs.get(blockIndex)!.inputJson;
                  accumulator.append(boundedPartial.text);
                  if (boundedPartial.truncated) {
                    // Force the accumulator's own truncation flag so the JSON
                    // is never parsed and the emitted metadata reports it.
                    accumulator.append('....');
                  }
                }
                break;
              }

              if (
                delta &&
                typeof delta === 'object' &&
                (delta.type === 'thinking_delta' || typeof delta.thinking === 'string')
              ) {
                const thinkingChunk =
                  typeof delta.thinking === 'string'
                    ? delta.thinking
                    : typeof delta.text === 'string'
                      ? delta.text
                      : '';
                if (thinkingChunk) {
                  assistantStream.appendThinking(
                    boundClaudeEventText(
                      thinkingChunk,
                      STREAM_THINKING_TEXT_MAX_BYTES,
                    ).text,
                  );
                }
                break;
              }

              // Handle text delta for assistant messages
              let textChunk = '';

              if (typeof delta === 'string') {
                textChunk = delta;
              } else if (delta && typeof delta === 'object') {
                if (typeof delta.text === 'string') {
                  textChunk = delta.text;
                } else if (typeof delta.delta === 'string') {
                  textChunk = delta.delta;
                } else if (typeof delta.partial === 'string') {
                  textChunk = delta.partial;
                }
              }

              if (textChunk) {
                assistantStream.appendAssistant(
                  boundClaudeEventText(
                    textChunk,
                    STREAM_ASSISTANT_TEXT_MAX_BYTES,
                  ).text,
                );
              }
              break;
            }

            case 'message_delta': {
              // message_delta usually contains metadata only (stop_reason, usage)
              // Don't emit final here to avoid duplicate finals
              break;
            }

            case 'message_stop': {
              // Emit final assistant message only on message_stop
              emitAssistant(true);
              break;
            }

            default:
              // Other stream events are ignored
              break;
          }
        } else if (message.type === 'assistant') {
          // Fallback for non-streaming assistant messages
          const content = extractBoundedClaudeMessageContent(message).content;
          if (content) {
            assistantStream.replaceAssistant(content);
            emitAssistant(true);
          }
        } else if (message.type === 'result') {
          // Final result - check for errors first
          const resultRecord = message as unknown as Record<string, unknown>;

          // Do not serialize the result payload: it may contain an arbitrarily
          // large final response. Log only fixed-size scalar diagnostics.
          console.error(
            `[ClaudeEngine] Result message: isError=${resultRecord.is_error === true}, durationMs=${typeof resultRecord.duration_ms === 'number' ? resultRecord.duration_ms : 0}, numTurns=${typeof resultRecord.num_turns === 'number' ? resultRecord.num_turns : 0}`,
          );

          // Extract and emit usage statistics
          const usage = resultRecord.usage as Record<string, unknown> | undefined;
          const totalCostUsd =
            typeof resultRecord.total_cost_usd === 'number' ? resultRecord.total_cost_usd : 0;
          const durationMs =
            typeof resultRecord.duration_ms === 'number' ? resultRecord.duration_ms : 0;
          const numTurns = typeof resultRecord.num_turns === 'number' ? resultRecord.num_turns : 0;

          if (usage || totalCostUsd > 0) {
            ctx.emit({
              type: 'usage',
              data: {
                sessionId,
                requestId,
                inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
                outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0,
                cacheReadInputTokens:
                  typeof usage?.cache_read_input_tokens === 'number'
                    ? usage.cache_read_input_tokens
                    : undefined,
                cacheCreationInputTokens:
                  typeof usage?.cache_creation_input_tokens === 'number'
                    ? usage.cache_creation_input_tokens
                    : undefined,
                totalCostUsd,
                durationMs,
                numTurns,
              },
            });
          }

          // Check if result contains errors (SDK puts error details here)
          // Note: is_error can be true even with empty errors array
          if (resultRecord.is_error) {
            const errorMsg = buildBoundedClaudeResultError(
              resultRecord.errors,
              resultRecord.result,
            );
            console.error(
              `[ClaudeEngine] Result error: ${redactDiagnosticText(errorMsg)}`,
            );

            // Check if this is a resume failure
            const isResumeFailure =
              errorMsg.includes('No conversation found') ||
              errorMsg.includes('Failed to resume session') ||
              errorMsg.includes('session ID');

            if (isResumeFailure && resumeClaudeSessionId) {
              // Clear the stored session ID so next request starts fresh
              if (ctx.persistClaudeSessionId && projectId) {
                try {
                  // Pass empty string to clear the session
                  await ctx.persistClaudeSessionId('');
                  console.error('[ClaudeEngine] Cleared invalid session ID');
                } catch {
                  // Ignore clear errors
                }
              }
              throw new Error(
                `Resume failed: ${errorMsg}. Session has been cleared - please retry.`,
              );
            }

            throw new Error(errorMsg);
          }

          // Extract content from successful result
          const resultContent = extractBoundedClaudeMessageContent(message).content;
          if (resultContent) {
            assistantStream.replaceAssistant(resultContent);
            emitAssistant(true);
          }
        } else if (message.type === 'system') {
          // Handle system messages
          const record = message as unknown as Record<string, unknown>;
          const subtype = this.pickFirstString(record.subtype);

          if (subtype === 'init') {
            // system:init - contains session_id and management information
            const parsedSessionId = parseBoundedClaudeSessionId(record.session_id);
            const claudeSessionId = parsedSessionId.id;

            if (parsedSessionId.rejected) {
              console.error(
                `[ClaudeEngine] Ignored invalid session ID (${parsedSessionId.observedBytes} UTF-8 bytes observed)`,
              );
            }

            if (claudeSessionId) {
              console.error(
                `[ClaudeEngine] Session initialized: ${redactDiagnosticText(claudeSessionId)}`,
              );

              // Persist the session ID if callback is provided and projectId exists
              if (ctx.persistClaudeSessionId && projectId) {
                try {
                  await ctx.persistClaudeSessionId(claudeSessionId);
                  console.error(
                    `[ClaudeEngine] Session ID persisted for project: ${redactDiagnosticText(projectId)}`,
                  );
                } catch (persistError) {
                  console.error(
                    `[ClaudeEngine] Failed to persist session ID: ${redactDiagnosticText(persistError)}`,
                  );
                }
              }
            }

            // Extract and persist management information
            if (ctx.persistManagementInfo) {
              try {
                const management = buildBoundedClaudeManagementInfo(record);
                await ctx.persistManagementInfo(management.info);
                console.error(
                  management.truncated
                    ? `[ClaudeEngine] Management info persisted with bounded fields: ${management.truncatedFields.join(', ')}`
                    : '[ClaudeEngine] Management info persisted',
                );
              } catch (persistError) {
                console.error(
                  `[ClaudeEngine] Failed to persist management info: ${redactDiagnosticText(persistError)}`,
                );
              }
            }
          } else if (subtype === 'status') {
            // system:status - log for debugging (e.g., compacting)
            const statusText = this.pickFirstString(record.status);
            console.error(
              `[ClaudeEngine] System status: ${redactDiagnosticText(statusText || 'unknown')}`,
            );
          }
        } else if (message.type === 'auth_status') {
          // Handle authentication status - SDK fields: isAuthenticating, output, error
          const record = message as unknown as Record<string, unknown>;
          const isAuthenticating = record.isAuthenticating === true;
          const authStatus = buildBoundedClaudeAuthStatus(record);

          console.error(
            `[ClaudeEngine] Auth status: isAuthenticating=${isAuthenticating}, hasError=${Boolean(authStatus.error)}`,
          );

          // Build content from output or error
          // Determine if login is required:
          // - Not currently authenticating AND (has error OR output contains login keywords)
          const requiresLogin = !isAuthenticating && authStatus.requiresLogin;

          // Emit auth status as a system message so UI can display login prompts
          const authSystemMessage: AgentMessage = {
            id: randomUUID(),
            sessionId,
            role: 'system',
            content: authStatus.content,
            messageType: 'status',
            cliSource: this.name,
            requestId,
            isStreaming: false,
            isFinal: !isAuthenticating,
            createdAt: new Date().toISOString(),
            metadata: {
              cli_type: 'claude',
              event_type: 'auth_status',
              isAuthenticating,
              output: authStatus.output,
              error: authStatus.error,
              requires_login: requiresLogin,
              truncated: authStatus.truncated || undefined,
              truncation: authStatus.truncated ? authStatus.truncation : undefined,
            },
          };

          ctx.emit({ type: 'message', data: createBoundedAgentMessage(authSystemMessage) });
        } else if (message.type === 'tool_progress') {
          // Handle tool progress - SDK fields: tool_use_id, tool_name, parent_tool_use_id, elapsed_time_seconds
          const record = message as unknown as Record<string, unknown>;
          const toolUseId = pickBoundedClaudeIdentifier(
            record.tool_use_id,
            CLAUDE_TOOL_ID_MAX_BYTES,
          );
          const toolName = this.pickFirstString(record.tool_name);
          const parentToolUseId = pickBoundedClaudeIdentifier(
            record.parent_tool_use_id,
            CLAUDE_TOOL_ID_MAX_BYTES,
          );
          const elapsedTimeSeconds =
            typeof record.elapsed_time_seconds === 'number'
              ? record.elapsed_time_seconds
              : undefined;

          if (toolName || toolUseId) {
            const displayName = toolName || toolUseId || 'tool';
            const elapsedStr =
              elapsedTimeSeconds !== undefined ? ` (${elapsedTimeSeconds.toFixed(1)}s)` : '';
            console.error(
              `[ClaudeEngine] Tool progress: ${redactDiagnosticText(displayName)}${elapsedStr}`,
            );

            // Use tool_use_id as message id if available, so UI can update the same progress entry
            const messageId = toolUseId ? `progress-${toolUseId}` : randomUUID();

            // Emit tool progress as a tool message
            const progressMessage: AgentMessage = {
              id: messageId,
              sessionId,
              role: 'tool',
              content: `${displayName} in progress${elapsedStr}`,
              messageType: 'tool_use',
              cliSource: this.name,
              requestId,
              isStreaming: true,
              isFinal: false,
              createdAt: new Date().toISOString(),
              metadata: {
                cli_type: 'claude',
                event_type: 'tool_progress',
                toolUseId,
                toolName,
                parentToolUseId,
                elapsedTimeSeconds,
              },
            };

            ctx.emit({ type: 'message', data: createBoundedAgentMessage(progressMessage) });
          }
        }
      }

      // Ensure final message is emitted
      if (assistantStream.hasContent()) {
        emitAssistant(true);
      }

      flushStderr();
      console.error('[ClaudeEngine] Query completed successfully');
    } catch (error) {
      caughtExecutionError = true;
      flushStderr();
      const message = redactDiagnosticText(error, CLAUDE_EVENT_ERROR_MAX_BYTES);
      const stderrLines = stderrDiagnostics.snapshot();

      // Log full stderr for debugging
      console.error(`[ClaudeEngine] Error: ${message}`);
      if (stderrLines.length > 0) {
        console.error(`[ClaudeEngine] Stderr (${stderrLines.length} lines):`);
        stderrLines.slice(-10).forEach((line) => console.error(`  ${line}`));
      }

      // Check if this is a resume failure from stderr
      const isResumeFailure =
        stderrLines.some(
          (line) =>
            line.includes('No conversation found') ||
            line.includes('Failed to resume session') ||
            line.includes('session ID'),
        ) ||
        message.includes('Resume failed');

      if (isResumeFailure && resumeClaudeSessionId && ctx.persistClaudeSessionId && projectId) {
        // Clear the stored session ID so next request starts fresh
        try {
          await ctx.persistClaudeSessionId('');
          console.error('[ClaudeEngine] Cleared invalid session ID due to resume failure');
        } catch {
          // Ignore clear errors
        }
      }

      // Classify errors for better UX
      const errorMessage = classifyClaudeDiagnosticError(message, stderrLines);
      executionError = createRedactedDiagnosticError(
        `ClaudeEngine: ${errorMessage}`,
        CLAUDE_EVENT_ERROR_MAX_BYTES,
      );
    } finally {
      flushStderr();
      removeExternalAbortListener?.();
      removeExternalAbortListener = null;

      // The adapter delays SDK `exit` until Node `close`, and the lifecycle
      // promise independently observes that same close. Await both before
      // releasing temporary inputs or settling ClaudeEngine.
      const capturedCompletion = processCompletionOutcome as Promise<{
        exit?: unknown;
        error?: Error;
      }> | null;
      const processOutcome = capturedCompletion ? await capturedCompletion : undefined;

      // Preserve the last accumulated state on success, error, and abort, and
      // guarantee no coalescing timer survives the engine execution.
      try {
        assistantStream.flushFinal();
      } finally {
        assistantStream.cancel();
        // Always cleanup temp files, even if the final stream flush fails.
        await cleanupTempFiles();
      }

      if (
        processOutcome?.error &&
        (!caughtExecutionError ||
          processOutcome.error.message === 'ClaudeEngine: execution was cancelled' ||
          processOutcome.error.message === 'ClaudeEngine: execution timed out')
      ) {
        supervisedCompletionError = createRedactedDiagnosticError(
          processOutcome.error,
          CLAUDE_EVENT_ERROR_MAX_BYTES,
        );
      }
    }

    if (supervisedCompletionError) throw supervisedCompletionError;
    if (executionError) throw executionError;
  }

  /**
   * Build environment variables for Claude Code.
   * SDK treats options.env as a complete replacement, so we explicitly merge process env.
   */
  private async buildClaudeEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env };

    // Ensure Node.js bin directory is in PATH (for child processes)
    const nodeBinDir = path.dirname(process.execPath);
    const currentPath = env.PATH || env.Path || '';
    if (!currentPath.includes(nodeBinDir)) {
      env.PATH = [nodeBinDir, currentPath].filter(Boolean).join(path.delimiter);
    }

    // Log configured Anthropic env vars without exposing any token material.
    const baseUrl = env.ANTHROPIC_BASE_URL;
    const authToken = env.ANTHROPIC_AUTH_TOKEN;
    const baseUrlStatus = describeClaudeBaseUrlConfiguration(baseUrl);
    if (baseUrlStatus) console.error(baseUrlStatus);
    const authTokenStatus = describeClaudeAuthTokenConfiguration(authToken);
    if (authTokenStatus) console.error(authTokenStatus);

    return env;
  }

  /**
   * Resolve project root path.
   */
  private resolveRepoPath(projectRoot?: string): string {
    const base =
      (projectRoot && projectRoot.trim()) || process.env.MCP_AGENT_PROJECT_ROOT || process.cwd();
    return path.resolve(base);
  }

  /**
   * Pick first string value from unknown input.
   */
  private pickFirstString(value: unknown): string | undefined {
    return pickBoundedClaudeString(value);
  }

  /**
   * Build metadata for tool result events.
   */
  private buildToolResultMetadata(block: Record<string, unknown>): Record<string, unknown> {
    const toolUseId = pickBoundedClaudeIdentifier(
      block.tool_use_id,
      CLAUDE_TOOL_ID_MAX_BYTES,
    );
    const isError = block.is_error === true;

    return {
      toolUseId,
      is_error: isError,
      status: isError ? 'failed' : 'completed',
      cli_type: 'claude',
    };
  }

  /**
   * Write an attachment to a temporary file and return its path.
   */
  private async writeAttachmentToTemp(attachment: {
    type: string;
    name: string;
    mimeType: string;
    dataBase64: string;
  }): Promise<string> {
    return writePrivateTempAttachment({
      ...attachment,
      type: 'image',
    });
  }
}
