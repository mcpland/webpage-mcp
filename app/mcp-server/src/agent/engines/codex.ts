import spawn from 'cross-spawn';
import readline from 'node:readline';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CODEX_AUTO_INSTRUCTIONS,
  DEFAULT_CODEX_CONFIG,
  DEFAULT_MCP_INSTANCE_ID,
  type CodexEngineConfig,
} from 'webpage-mcp-shared';
import type { AgentEngine, EngineExecutionContext, EngineInitOptions } from './types';
import { getProject } from '../project-service';
import { resolveWebpageMcpStdioConfig } from './mcp-stdio-config';
import { createAgentEventDedupKey } from './event-dedupe';
import {
  BoundedAssistantStream,
  BoundedMap,
  BoundedSet,
  STREAM_ACTIVE_COMMAND_MAX_ENTRIES,
  STREAM_ASSISTANT_TEXT_MAX_BYTES,
  STREAM_DEDUPE_MAX_ENTRIES,
  STREAM_THINKING_TEXT_MAX_BYTES,
  STREAM_TOOL_CONTENT_MAX_BYTES,
  STREAM_TOOL_FIELD_MAX_BYTES,
  boundStreamText,
  createBoundedAgentMessage,
  type AssistantStreamSnapshot,
} from './stream-output';

type TodoListPhase = 'started' | 'update' | 'completed';

interface TodoListItem {
  text: string;
  completed: boolean;
  index: number;
}

/**
 * Build the CLI arguments that enforce the configured Codex sandbox.
 *
 * `codex exec` is non-interactive in this integration, so safe sandbox modes
 * use `approval=never` while still keeping the filesystem sandbox enabled.
 * The all-access bypass is only permitted when it was explicitly selected.
 */
export function buildCodexSandboxArgs(
  config: Pick<CodexEngineConfig, 'sandboxMode'>,
): string[] {
  if (config.sandboxMode === 'danger-full-access') {
    return ['--dangerously-bypass-approvals-and-sandbox'];
  }

  return ['--sandbox', config.sandboxMode, '--ask-for-approval', 'never'];
}

export function buildCodexSpawnSpec(): { command: string; shell: false } {
  return {
    // cross-spawn resolves npm's codex.cmd shim on Windows.
    command: 'codex',
    // Keep user-controlled prompt text out of cmd.exe command parsing.
    shell: false,
  };
}

/**
 * CodexEngine integrates the Codex CLI as an AgentEngine implementation.
 *
 * The implementation is intentionally self-contained and does not persist messages;
 * it focuses on streaming Codex JSON events into RealtimeEvent envelopes that the
 * sidepanel UI can consume.
 *
 * Note:This engine is based on the event protocol of the Codex adapter in other/cweb and fully handles
 * item.started/item.delta/item.completed/item.failed/error wait for events, and
 * Push the encoded RealtimeEvent to the sidepanel through AgentStreamManager,
 * Ensure that the data link "Sidepanel → MCP Server → Codex CLI → Sidepanel" is closed loop.
 */
export class CodexEngine implements AgentEngine {
  public readonly name = 'codex' as const;
  public readonly supportsMcp = false;
  constructor(public readonly instanceId = DEFAULT_MCP_INSTANCE_ID) {}

  /**
   * Maximum number of stderr lines to keep in memory to avoid unbounded growth.
   */
  private static readonly MAX_STDERR_LINES = 200;

  async initializeAndRun(options: EngineInitOptions, ctx: EngineExecutionContext): Promise<void> {
    const {
      sessionId,
      instruction,
      model,
      projectRoot,
      projectId,
      requestId,
      signal,
      attachments,
      resolvedImagePaths,
      codexConfig,
    } = options;
    const repoPath = this.resolveRepoPath(projectRoot);

    // Check if already aborted
    if (signal?.aborted) {
      throw new Error('CodexEngine: execution was cancelled');
    }

    const normalizedInstruction = instruction.trim();
    if (!normalizedInstruction) {
      throw new Error('CodexEngine: instruction must not be empty');
    }

    // Merge user config with defaults
    const resolvedConfig: CodexEngineConfig = {
      ...DEFAULT_CODEX_CONFIG,
      ...(codexConfig ?? {}),
    };

    // Ensure autoInstructions has a value
    if (!resolvedConfig.autoInstructions?.trim()) {
      resolvedConfig.autoInstructions = CODEX_AUTO_INSTRUCTIONS;
    }

    // Resolve project-scoped Webpage MCP toggle (default: enabled)
    const enableWebpageMcp = await (async (): Promise<boolean> => {
      if (!projectId) return true;
      try {
        const project = await getProject(projectId);
        return project?.enableWebpageMcp !== false;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[CodexEngine] Failed to load project enableWebpageMcp, defaulting to enabled: ${message}`,
        );
        return true;
      }
    })();

    // Optionally append project context to the prompt
    const prompt = resolvedConfig.appendProjectContext
      ? await this.appendProjectContext(normalizedInstruction, repoPath)
      : normalizedInstruction;

    const spawnSpec = buildCodexSpawnSpec();
    const args: string[] = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--cd',
      repoPath,
    ];

    args.push(...buildCodexSandboxArgs(resolvedConfig));

    // Add Codex configuration arguments
    args.push(...this.buildCodexConfigArgs(resolvedConfig));

    // Inject local Webpage MCP server via stdio bridge (no HTTP dependency)
    if (enableWebpageMcp) {
      const stdioConfig = resolveWebpageMcpStdioConfig(this.instanceId);
      args.push('-c', 'mcp_servers.webpage_mcp.type="stdio"');
      args.push('-c', `mcp_servers.webpage_mcp.command=${JSON.stringify(stdioConfig.command)}`);
      args.push('-c', `mcp_servers.webpage_mcp.args=${JSON.stringify(stdioConfig.args)}`);
      if (stdioConfig.env && Object.keys(stdioConfig.env).length > 0) {
        args.push('-c', `mcp_servers.webpage_mcp.env=${JSON.stringify(stdioConfig.env)}`);
      }
      console.error(
        `[CodexEngine] Webpage MCP server enabled via stdio: ${stdioConfig.command} ${stdioConfig.args.join(' ')}`,
      );
    } else {
      console.error('[CodexEngine] Webpage MCP server disabled');
    }

    if (model && model.trim()) {
      args.push('--model', model.trim());
    }

    // Process image attachments - prefer resolvedImagePaths (persisted), fallback to temp files
    const tempFiles: string[] = [];
    const hasResolvedPaths = resolvedImagePaths && resolvedImagePaths.length > 0;

    if (hasResolvedPaths) {
      // Use pre-resolved persistent paths (preferred - no temp files needed)
      console.error(`[CodexEngine] Using ${resolvedImagePaths.length} pre-resolved image path(s)`);
      for (const imagePath of resolvedImagePaths) {
        args.push('--image', imagePath);
      }
    } else if (attachments && attachments.length > 0) {
      // Fallback: write base64 to temp files (legacy behavior)
      for (const attachment of attachments) {
        if (attachment.type === 'image') {
          try {
            const tempFile = await this.writeAttachmentToTemp(attachment);
            tempFiles.push(tempFile);
            args.push('--image', tempFile);
          } catch (err) {
            console.error('[CodexEngine] Failed to write attachment to temp file:', err);
          }
        }
      }
    }

    args.push(prompt);

    // Use explicit Promise wrapping to ensure child process errors are properly rejected.
    return new Promise<void>((resolve, reject) => {
      const child = spawn(spawnSpec.command, args, {
        cwd: repoPath,
        env: this.buildCodexEnv(),
        shell: spawnSpec.shell,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // State management
      const stderrBuffer: string[] = [];
      let hasCompleted = false;
      let timedOut = false;
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | null = null;

      // Readline interface - declared early to avoid TDZ issues in finish()
      let rl: readline.Interface | null = null;

      // Assistant message state
      let assistantMessageId: string | null = null;
      let assistantCreatedAt: string | null = null;
      const streamedToolHashes = new BoundedSet<string>(STREAM_DEDUPE_MAX_ENTRIES);
      const activeCommands = new BoundedMap<string, { command?: string }>(
        STREAM_ACTIVE_COMMAND_MAX_ENTRIES,
      );
      let assistantStream: BoundedAssistantStream | null = null;

      /**
       * Cleanup temporary files created for image attachments.
       */
      const cleanupTempFiles = async (): Promise<void> => {
        if (tempFiles.length === 0) return;

        const fs = await import('node:fs/promises');
        for (const filePath of tempFiles) {
          try {
            await fs.unlink(filePath);
            console.error(`[CodexEngine] Cleaned up temp file: ${filePath}`);
          } catch (err) {
            // Ignore errors during cleanup - file may already be deleted
            console.error(`[CodexEngine] Failed to cleanup temp file ${filePath}:`, err);
          }
        }
      };

      /**
       * Cleanup and settle the promise (resolve or reject).
       * Waits for temp file cleanup to complete before settling.
       */
      const finish = async (error?: unknown): Promise<void> => {
        if (settled) return;
        settled = true;

        // Always flush the last coalesced snapshot before teardown, then clear
        // its timer so abort/error paths cannot emit after this run settles.
        assistantStream?.flushFinal();
        assistantStream?.cancel();

        // Clear timeout
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }

        // Close readline interface
        if (rl) {
          try {
            rl.close();
          } catch {
            // Ignore close errors during cleanup
          }
        }

        // Kill child process if still running
        if (!child.killed) {
          try {
            child.kill();
          } catch {
            // Ignore kill errors during cleanup
          }
        }

        // Cleanup temp files after process is killed (wait for completion)
        await cleanupTempFiles();

        // Settle the promise
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } else {
          resolve();
        }
      };

      // Handle child process error immediately after spawn (e.g., command not found)
      child.on('error', (error) => {
        const message =
          error instanceof Error
            ? error.message
            : stderrBuffer.slice(-5).join('\n') || 'Codex CLI failed to start';
        void finish(new Error(`CodexEngine: ${message}`));
      });

      // Listen for abort signal to cancel execution
      const abortHandler = signal
        ? () => {
            console.error('[CodexEngine] Execution cancelled via abort signal');
            void finish(new Error('CodexEngine: execution was cancelled'));
          }
        : null;

      if (signal && abortHandler) {
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      // Collect stderr with bounded buffer
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (!text) return;

        stderrBuffer.push(text);
        // Keep only the most recent lines to prevent memory growth
        if (stderrBuffer.length > CodexEngine.MAX_STDERR_LINES) {
          stderrBuffer.splice(0, stderrBuffer.length - CodexEngine.MAX_STDERR_LINES);
        }

        console.error('[CodexEngine][stderr]', text);
      });

      rl = readline.createInterface({ input: child.stdout });

      /**
       * Reset assistant buffers after emitting a final message.
       */
      const resetAssistantBuffers = (): void => {
        assistantStream?.reset();
        assistantMessageId = null;
        assistantCreatedAt = null;
      };

      const emitAssistantSnapshot = (
        snapshot: AssistantStreamSnapshot,
        isFinal: boolean,
      ): void => {
        const content = snapshot.content;
        if (!content) return;

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

      assistantStream = new BoundedAssistantStream(emitAssistantSnapshot);

      // Helper retained for terminal event handlers. Intermediate snapshots are
      // queued by appendAssistant/appendThinking and coalesced by the stream.
      const emitAssistant = (isFinal: boolean): void => {
        if (isFinal) assistantStream?.flushFinal();
      };

      // Helper: emit tool message with deduplication
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
          metadata: { cli_type: 'codex', ...metadata },
        });
        const hash = createAgentEventDedupKey(
          `${messageType}:${message.content}:${JSON.stringify(message.metadata)}:${sessionId}:${requestId || ''}`,
        );
        if (streamedToolHashes.has(hash)) return;
        streamedToolHashes.add(hash);

        ctx.emit({ type: 'message', data: message });
      };

      // Event handlers for specific item types
      const emitCommandStart = (item: Record<string, unknown>): void => {
        const id = this.pickFirstString(item.id) ?? randomUUID();
        const rawCommand = this.pickFirstString(item.command);
        const command = rawCommand
          ? boundStreamText(rawCommand, STREAM_TOOL_FIELD_MAX_BYTES).text
          : undefined;
        activeCommands.set(id, { command });
        dispatchToolMessage(
          command ? `Running: ${command}` : 'Running command',
          {
            toolName: 'Bash',
            tool_name: 'Bash',
            command,
            status: this.pickFirstString(item.status) ?? 'in_progress',
          },
          'tool_use',
          true,
        );
      };

      const emitCommandResult = (item: Record<string, unknown>): void => {
        const id = this.pickFirstString(item.id);
        const tracked = id ? activeCommands.get(id) : undefined;
        if (id) {
          activeCommands.delete(id);
        }
        const rawCommand = this.pickFirstString(item.command);
        const command = rawCommand
          ? boundStreamText(rawCommand, STREAM_TOOL_FIELD_MAX_BYTES).text
          : tracked?.command;
        const rawOutput = this.pickFirstString(item.aggregated_output) ?? '';
        const outputSnapshot = boundStreamText(rawOutput, STREAM_TOOL_CONTENT_MAX_BYTES);
        const output = outputSnapshot.text;
        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
        const status = this.pickFirstString(item.status);
        const isError = status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0);

        const summary = command ? `Ran: ${command}` : 'Executed shell command';
        const exitSuffix = typeof exitCode === 'number' ? ` (exit ${exitCode})` : '';
        const body = output.trim();
        const fullContent = body ? `${summary}${exitSuffix}\n\n${body}` : `${summary}${exitSuffix}`;

        dispatchToolMessage(
          fullContent,
          {
            toolName: 'Bash',
            tool_name: 'Bash',
            command,
            exitCode,
            status,
            output,
            truncated: outputSnapshot.truncated || undefined,
            truncation: outputSnapshot.truncated
              ? [
                  {
                    field: 'toolOutput',
                    originalBytes: outputSnapshot.originalBytes,
                    retainedBytes: outputSnapshot.retainedBytes,
                  },
                ]
              : undefined,
            is_error: isError || undefined,
          },
          'tool_result',
          false,
        );
      };

      const emitFileChange = (item: Record<string, unknown>): void => {
        const { content, metadata } = this.summarizeApplyPatch({
          changes: item.changes as Record<string, unknown> | Array<Record<string, unknown>>,
        });
        const status = this.pickFirstString(item.status) ?? 'completed';
        const isError = status === 'failed';
        const toolName =
          (metadata?.toolName as string) || (metadata?.tool_name as string) || 'Edit';

        dispatchToolMessage(
          isError ? `Failed: ${content}` : content,
          { ...metadata, toolName, tool_name: toolName, status, is_error: isError || undefined },
          'tool_result',
          false,
        );
      };

      const emitTodoListUpdate = (record: Record<string, unknown>, phase: TodoListPhase): void => {
        const rawItems = this.extractTodoListItems(record);
        const items = this.normalizeTodoListItems(rawItems);
        const content = this.buildTodoListContent(items, phase);
        const status =
          this.pickFirstString(record.status) ??
          (phase === 'completed' ? 'completed' : 'in_progress');
        const metadata = this.createTodoListMetadata(items, phase, {
          status,
          planId: this.pickFirstString(record.id),
        });

        dispatchToolMessage(
          content,
          metadata,
          phase === 'completed' ? 'tool_result' : 'tool_use',
          phase === 'update',
        );
      };

      // Item event handlers
      const handleItemStarted = (item: unknown): void => {
        if (!item || typeof item !== 'object') return;
        const record = item as Record<string, unknown>;
        const type = this.pickFirstString(record.type);
        if (type === 'command_execution') {
          emitCommandStart(record);
        } else if (type === 'todo_list') {
          emitTodoListUpdate(record, 'started');
        }
      };

      const handleItemDelta = (delta: unknown): void => {
        if (!delta || typeof delta !== 'object') return;
        const record = delta as Record<string, unknown>;
        const type = this.pickFirstString(record.type);

        if (type === 'agent_message') {
          const text = this.pickFirstString(record.text);
          if (text) {
            assistantStream?.appendAssistant(text);
          }
        } else if (type === 'reasoning') {
          const text = this.pickFirstString(record.text);
          if (text) {
            assistantStream?.appendThinking(text);
          }
        } else if (type === 'todo_list') {
          emitTodoListUpdate(record, 'update');
        }
      };

      const handleItemCompleted = (item: unknown): void => {
        if (!item || typeof item !== 'object') return;
        const record = item as Record<string, unknown>;
        const type = this.pickFirstString(record.type);

        switch (type) {
          case 'command_execution':
            emitCommandResult(record);
            break;
          case 'file_change':
            emitFileChange(record);
            break;
          case 'todo_list':
            emitTodoListUpdate(record, 'completed');
            break;
          case 'agent_message': {
            const text = this.pickFirstString(record.text);
            if (text) assistantStream?.replaceAssistant(text);
            emitAssistant(true);
            resetAssistantBuffers();
            break;
          }
          case 'reasoning': {
            const text = this.pickFirstString(record.text);
            if (text && !assistantStream?.thinkingEndsWith(text)) {
              assistantStream?.appendThinking(text);
            }
            break;
          }
          default: {
            const text = this.pickFirstString(record.text);
            if (text) {
              assistantStream?.appendThinking(text);
            }
            break;
          }
        }
      };

      // Setup timeout
      const timeoutMs =
        Number.parseInt(process.env.CODEX_ENGINE_TIMEOUT_MS || '', 10) || 15 * 60 * 1000;
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        // Close readline to exit the loop
        try {
          rl.close();
        } catch {
          // Ignore
        }
        if (!child.killed) {
          try {
            child.kill();
          } catch {
            // Ignore
          }
        }
      }, timeoutMs);
      timeoutHandle.unref?.();

      // Cleanup timeout and handle abnormal exit
      child.on('close', (code: number | null, closeSignal: NodeJS.Signals | null) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }

        // If already timed out, settled, or completed normally, do nothing
        if (timedOut || settled || hasCompleted) {
          return;
        }

        // Build error detail from exit code and signal
        const detailParts: string[] = [];
        if (typeof code === 'number') {
          detailParts.push(`exit code ${code}`);
        }
        if (closeSignal) {
          detailParts.push(`signal ${closeSignal}`);
        }
        const detail = detailParts.length > 0 ? detailParts.join(', ') : 'unexpected shutdown';

        // Emit final assistant message and mark as failed
        emitAssistant(true);
        resetAssistantBuffers();
        hasCompleted = true;
        void finish(new Error(`CodexEngine: process terminated (${detail})`));
      });

      // Main event processing loop (wrapped in IIFE to handle async properly)
      void (async () => {
        try {
          for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
              console.warn('[CodexEngine] Failed to parse Codex event line:', trimmed);
              continue;
            }

            const eventType = this.pickFirstString(event.type);
            switch (eventType) {
              case 'item.started':
                handleItemStarted((event as { item?: unknown }).item ?? null);
                break;
              case 'item.delta':
                handleItemDelta((event as { delta?: unknown }).delta ?? null);
                break;
              case 'item.completed':
                handleItemCompleted((event as { item?: unknown }).item ?? null);
                break;
              case 'item.failed': {
                const item = (event as { item?: unknown }).item ?? null;
                handleItemCompleted(item);
                // Flush assistant message before throwing (aligned with other/cweb)
                emitAssistant(true);
                resetAssistantBuffers();
                const msg =
                  (item &&
                    typeof item === 'object' &&
                    this.pickFirstString((item as Record<string, unknown>).error)) ||
                  'Codex execution failed';
                hasCompleted = true;
                throw new Error(msg);
              }
              case 'error': {
                // Flush assistant message before throwing (aligned with other/cweb)
                emitAssistant(true);
                resetAssistantBuffers();
                const msg =
                  this.pickFirstString((event as { error?: unknown }).error) ||
                  this.pickFirstString((event as { message?: unknown }).message) ||
                  stderrBuffer.slice(-5).join('\n') ||
                  'Codex execution error';
                hasCompleted = true;
                throw new Error(msg);
              }
              case 'turn.completed':
                emitAssistant(true);
                resetAssistantBuffers();
                hasCompleted = true;
                break;
              default:
                // Non-critical events are ignored
                break;
            }
          }

          // Check for timeout after loop exits
          if (timedOut) {
            throw new Error('CodexEngine: execution timed out');
          }

          // Emit final assistant message if not already completed
          if (!hasCompleted) {
            emitAssistant(true);
            resetAssistantBuffers();
            hasCompleted = true;
          }

          await finish();
        } catch (error) {
          await finish(error);
        }
      })();
    });
  }

  private resolveRepoPath(projectRoot?: string): string {
    const base =
      (projectRoot && projectRoot.trim()) || process.env.MCP_AGENT_PROJECT_ROOT || process.cwd();
    return path.resolve(base);
  }

  /**
   * Append project context (file listing) to the prompt.
   * Aligned with other/cweb implementation.
   */
  private async appendProjectContext(baseInstruction: string, repoPath: string): Promise<string> {
    try {
      const fs = await import('node:fs/promises');
      const entries = await fs.readdir(repoPath, { withFileTypes: true });
      const visible = entries
        .filter((entry) => !entry.name.startsWith('.git') && entry.name !== 'AGENTS.md')
        .map((entry) => entry.name);

      if (visible.length === 0) {
        return `${baseInstruction}

<current_project_context>
This is an empty project directory. Work directly in the current folder without creating extra subdirectories.
</current_project_context>`;
      }

      return `${baseInstruction}

<current_project_context>
Current files in project directory: ${visible.sort().join(', ')}
Work directly in the current directory. Do not create subdirectories unless specifically requested.
</current_project_context>`;
    } catch (error) {
      console.warn('[CodexEngine] Failed to append project context:', error);
      return baseInstruction;
    }
  }

  /**
   * Build Codex CLI configuration arguments from the resolved config.
   * Aligned with other/cweb implementation for feature parity.
   */
  private buildCodexConfigArgs(config: CodexEngineConfig): string[] {
    const args: string[] = [];

    const pushConfig = (key: string, value: string | number | boolean): void => {
      args.push('-c', `${key}=${String(value)}`);
    };

    pushConfig('include_apply_patch_tool', config.includeApplyPatchTool);
    pushConfig('include_plan_tool', config.includePlanTool);
    pushConfig('tools.web_search_request', config.enableWebSearch);
    pushConfig('use_experimental_streamable_shell_tool', config.useStreamableShell);
    pushConfig('sandbox_mode', config.sandboxMode);
    pushConfig('max_turns', config.maxTurns);
    pushConfig('max_thinking_tokens', config.maxThinkingTokens);
    pushConfig('reasoning_effort', config.reasoningEffort);
    args.push('-c', `instructions=${JSON.stringify(config.autoInstructions)}`);

    return args;
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
    const os = await import('node:os');
    const fs = await import('node:fs/promises');

    const tempDir = os.tmpdir();
    const ext = attachment.mimeType.split('/')[1] || 'bin';
    const sanitizedName = attachment.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const fileName = `mcp-agent-${Date.now()}-${sanitizedName}.${ext}`;
    const filePath = path.join(tempDir, fileName);

    const buffer = Buffer.from(attachment.dataBase64, 'base64');
    await fs.writeFile(filePath, buffer);

    return filePath;
  }

  private buildCodexEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const extraPaths: string[] = [];
    const globalPath = process.env.NPM_GLOBAL_PATH;
    if (globalPath) {
      extraPaths.push(globalPath);
    }
    // Enhanced Windows PATH handling (aligned with other/cweb)
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA;
      const localApp = process.env.LOCALAPPDATA;
      if (appData) {
        extraPaths.push(path.join(appData, 'npm'));
      }
      if (localApp) {
        extraPaths.push(path.join(localApp, 'Programs', 'nodejs'));
      }
    }
    if (extraPaths.length > 0) {
      const currentPath = env.PATH || env.Path || '';
      env.PATH = [...extraPaths, currentPath].filter(Boolean).join(path.delimiter);
    }
    return env;
  }

  private pickFirstString(value: unknown): string | undefined {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const candidate = this.pickFirstString(entry);
        if (candidate) {
          return candidate;
        }
      }
      return undefined;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const candidate = this.pickFirstString(record[key]);
        if (candidate) {
          return candidate;
        }
      }
    }
    return undefined;
  }

  private summarizeApplyPatch(payload: {
    changes?: Record<string, unknown> | Array<Record<string, unknown>>;
  }): { content: string; metadata: Record<string, unknown> } {
    const changes = payload?.changes;
    const files: string[] = [];
    if (Array.isArray(changes)) {
      for (const entry of changes) {
        const file =
          entry && typeof entry === 'object'
            ? ((entry as Record<string, unknown>).path as string) ||
              ((entry as Record<string, unknown>).file as string)
            : undefined;
        if (file && typeof file === 'string') {
          files.push(file);
        }
      }
    } else if (changes && typeof changes === 'object') {
      for (const key of Object.keys(changes)) {
        files.push(key);
      }
    }

    const unique = Array.from(new Set(files));
    const summary =
      unique.length === 0
        ? 'Applied file changes'
        : unique.length === 1
          ? `Updated ${unique[0]}`
          : `Updated ${unique.length} files (${unique
              .slice(0, 3)
              .join(', ')}${unique.length > 3 ? ', ...' : ''})`;

    return {
      content: summary,
      metadata: {
        files: unique,
      },
    };
  }

  private extractTodoListItems(record: Record<string, unknown>): unknown {
    if (Array.isArray(record.items)) {
      return record.items;
    }
    const nestedItem = record.item;
    if (
      nestedItem &&
      typeof nestedItem === 'object' &&
      Array.isArray((nestedItem as Record<string, unknown>).items)
    ) {
      return (nestedItem as Record<string, unknown>).items;
    }
    const delta = record.delta;
    if (
      delta &&
      typeof delta === 'object' &&
      Array.isArray((delta as Record<string, unknown>).items)
    ) {
      return (delta as Record<string, unknown>).items;
    }
    return [];
  }

  private normalizeTodoListItems(input: unknown): TodoListItem[] {
    if (!Array.isArray(input)) {
      return [];
    }

    const result: TodoListItem[] = [];

    input.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const record = entry as Record<string, unknown>;
      const text = this.pickFirstString(record.text) ?? `Step ${index + 1}`;
      const completed = record.completed === true || record.done === true;
      result.push({
        text,
        completed,
        index,
      });
    });

    return result;
  }

  private buildTodoListContent(items: TodoListItem[], phase: TodoListPhase): string {
    if (items.length === 0) {
      switch (phase) {
        case 'started':
          return 'Started plan with no explicit steps.';
        case 'completed':
          return 'Plan completed.';
        default:
          return 'Plan updated.';
      }
    }

    const header =
      phase === 'completed'
        ? 'Plan completed:'
        : phase === 'started'
          ? 'Plan generated:'
          : 'Plan updated:';

    const stepLines = items.map((item, idx) => {
      const bullet = item.completed ? '✅' : '⬜️';
      const label = `Step ${idx + 1}`;
      return `${bullet} ${label}: ${item.text}`;
    });

    return [header, ...stepLines].join('\n');
  }

  private createTodoListMetadata(
    items: TodoListItem[],
    phase: TodoListPhase,
    extra?: Record<string, unknown>,
  ): Record<string, unknown> {
    const totalSteps = items.length;
    const completedSteps = items.filter((item) => item.completed).length;
    return {
      toolName: 'Plan',
      tool_name: 'Plan',
      planPhase: phase,
      planStatus: phase === 'completed' ? 'completed' : 'in_progress',
      totalSteps,
      completedSteps,
      items: items.map(({ text, completed, index }) => ({
        text,
        completed,
        index,
      })),
      ...(extra ?? {}),
    };
  }

}
