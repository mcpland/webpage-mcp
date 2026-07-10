import spawn from 'cross-spawn';
import readline from 'node:readline';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import {
  AGENT_CODEX_AUTO_INSTRUCTIONS_MAX_BYTES,
  AGENT_FINAL_PROMPT_MAX_BYTES,
  CODEX_AUTO_INSTRUCTIONS,
  DEFAULT_CODEX_CONFIG,
  DEFAULT_MCP_INSTANCE_ID,
  type CodexEngineConfig,
} from 'webpage-mcp-shared';
import type {
  AgentEngine,
  EngineExecutionContext,
  EngineInitOptions,
} from './types';
import { getProject } from '../project-service';
import { validateCodexConfig } from '../session-security';
import { resolveWebpageMcpStdioConfig } from './mcp-stdio-config';
import { createAgentEventDedupKey } from './event-dedupe';
import {
  ChildProcessLifecycle,
  type ChildProcessExit,
  shouldDetachChildProcess,
} from './child-process-lifecycle';
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
import {
  removePrivateTempAttachment,
  writePrivateTempAttachment,
} from './private-temp-attachment';
import { resolveTrustedExecutable } from './trusted-executable';

/** Resource budgets for the optional top-level project directory summary. */
export const CODEX_PROJECT_CONTEXT_MAX_ENTRIES = 1_000;
export const CODEX_PROJECT_CONTEXT_ENTRY_NAME_MAX_BYTES = 1_024;
export const CODEX_PROJECT_CONTEXT_MAX_BYTES = 64 * 1024;
export const CODEX_AUTO_INSTRUCTIONS_MAX_BYTES =
  AGENT_CODEX_AUTO_INSTRUCTIONS_MAX_BYTES;
export const CODEX_ENGINE_PROMPT_MAX_BYTES =
  AGENT_FINAL_PROMPT_MAX_BYTES + CODEX_PROJECT_CONTEXT_MAX_BYTES;

const PROJECT_CONTEXT_PREFIX =
  '\n\n<current_project_context>\nCurrent files in project directory: ';
const EMPTY_PROJECT_CONTEXT_PREFIX =
  '\n\n<current_project_context>\nThis is an empty project directory.';
const PROJECT_CONTEXT_TRUNCATION =
  '\nProject directory listing was truncated to configured resource limits.';
const PROJECT_CONTEXT_SUFFIX =
  '\nWork directly in the current directory. Do not create subdirectories unless specifically requested.\n</current_project_context>';
const AUTO_INSTRUCTIONS_PREFIX = '<webpage_mcp_auto_instructions>\n';
const AUTO_INSTRUCTIONS_SUFFIX = '\n</webpage_mcp_auto_instructions>';

interface ProjectContextEntry {
  name: string;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function compareProjectEntryNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapePromptXmlText(value: string): string {
  // Escape ampersands first so the entities introduced for angle brackets are
  // not escaped a second time.
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function replaceInvalidXmlControls(value: string): string {
  let sanitized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isInvalid =
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f);
    sanitized += isInvalid ? '\uFFFD' : character;
  }
  return sanitized;
}

function sanitizePromptXmlText(value: string): string {
  return replaceInvalidXmlControls(value.replace(/\r\n?/g, '\n'));
}

function sanitizeProjectContextName(value: string): string {
  let sanitized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized += codePoint <= 0x1f || codePoint === 0x7f ? '\uFFFD' : character;
  }
  return sanitized;
}

function assertCodexAutoInstructionsLimit(autoInstructions: string): void {
  const autoInstructionBytes = utf8ByteLength(autoInstructions);
  if (autoInstructionBytes > CODEX_AUTO_INSTRUCTIONS_MAX_BYTES) {
    throw new Error(
      `CodexEngine: autoInstructions exceeds the ${CODEX_AUTO_INSTRUCTIONS_MAX_BYTES}-byte UTF-8 limit`,
    );
  }
}

/** Build the explicit developer-instruction section sent through stdin. */
export function buildCodexAutoInstructionsBlock(autoInstructions: string): string {
  assertCodexAutoInstructionsLimit(autoInstructions);

  const escaped = escapePromptXmlText(sanitizePromptXmlText(autoInstructions));
  return `${AUTO_INSTRUCTIONS_PREFIX}${escaped}${AUTO_INSTRUCTIONS_SUFFIX}`;
}

function composeCodexPromptParts(
  autoInstructionsBlock: string,
  instruction: string,
  projectContext: string,
): string {
  const parts = [autoInstructionsBlock, '\n\n', instruction, projectContext];
  let promptBytes = 0;
  for (const part of parts) {
    promptBytes += utf8ByteLength(part);
    if (promptBytes > CODEX_ENGINE_PROMPT_MAX_BYTES) {
      throw new Error(
        `CodexEngine: prompt exceeds the ${CODEX_ENGINE_PROMPT_MAX_BYTES}-byte UTF-8 limit`,
      );
    }
  }
  return parts.join('');
}

/** Compose bounded prompt sections only after their aggregate size is known. */
export function buildCodexPrompt(
  autoInstructions: string,
  instruction: string,
  projectContext = '',
): string {
  return composeCodexPromptParts(
    buildCodexAutoInstructionsBlock(autoInstructions),
    instruction,
    projectContext,
  );
}

function boundProjectEntryName(value: string): {
  text: string;
  truncated: boolean;
} {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= CODEX_PROJECT_CONTEXT_ENTRY_NAME_MAX_BYTES) {
    return { text: value, truncated: false };
  }

  const marker = '…';
  const prefixBytes =
    CODEX_PROJECT_CONTEXT_ENTRY_NAME_MAX_BYTES - utf8ByteLength(marker);
  const prefix = encoded
    .subarray(0, prefixBytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  // The escaped input only contains &amp;, &lt;, and &gt; entities. If the
  // byte boundary lands inside one, remove that incomplete entity so the
  // surrounding XML-like prompt remains structurally well formed.
  const lastAmpersand = prefix.lastIndexOf('&');
  const lastSemicolon = prefix.lastIndexOf(';');
  const entitySafePrefix =
    lastAmpersand > lastSemicolon ? prefix.slice(0, lastAmpersand) : prefix;
  return { text: `${entitySafePrefix}${marker}`, truncated: true };
}

/**
 * Build a deterministic, byte-bounded project summary from a bounded prefix
 * of a directory iterator. Production passes an fs.Dir so a very large
 * directory is never materialized by readdir before the limit is applied.
 */
export async function buildCodexProjectContext(
  entries: Iterable<ProjectContextEntry> | AsyncIterable<ProjectContextEntry>,
): Promise<string> {
  const visibleNames: string[] = [];
  let inspectedEntries = 0;
  let truncated = false;

  for await (const entry of entries) {
    // Read one sentinel entry beyond the retained limit so exact-limit
    // directories are not incorrectly labelled as truncated.
    if (inspectedEntries >= CODEX_PROJECT_CONTEXT_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    inspectedEntries += 1;

    if (entry.name.startsWith('.git') || entry.name === 'AGENTS.md') {
      continue;
    }

    // Control and XML structure characters in a filename must not be able to
    // create prompt instructions. Apply the byte limit to the escaped form.
    const sanitizedName = sanitizeProjectContextName(entry.name);
    const escapedName = escapePromptXmlText(sanitizedName);
    const boundedName = boundProjectEntryName(escapedName);
    visibleNames.push(boundedName.text);
    if (boundedName.truncated) truncated = true;
  }

  visibleNames.sort(compareProjectEntryNames);

  const prefix =
    visibleNames.length === 0
      ? EMPTY_PROJECT_CONTEXT_PREFIX
      : PROJECT_CONTEXT_PREFIX;
  const fixedBytes =
    utf8ByteLength(prefix) +
    utf8ByteLength(PROJECT_CONTEXT_TRUNCATION) +
    utf8ByteLength(PROJECT_CONTEXT_SUFFIX);
  let remainingBytes = CODEX_PROJECT_CONTEXT_MAX_BYTES - fixedBytes;
  if (remainingBytes < 0) {
    throw new Error(
      'CodexEngine: project context framing exceeds its byte limit',
    );
  }

  const retainedNames: string[] = [];
  if (visibleNames.length > 0) {
    for (const name of visibleNames) {
      const token = retainedNames.length === 0 ? name : `, ${name}`;
      const tokenBytes = utf8ByteLength(token);
      if (tokenBytes > remainingBytes) {
        truncated = true;
        break;
      }
      retainedNames.push(name);
      remainingBytes -= tokenBytes;
    }
  }

  const listing = retainedNames.join(', ');
  const context = `${prefix}${listing}${truncated ? PROJECT_CONTEXT_TRUNCATION : ''}${PROJECT_CONTEXT_SUFFIX}`;
  if (utf8ByteLength(context) > CODEX_PROJECT_CONTEXT_MAX_BYTES) {
    throw new Error('CodexEngine: project context exceeds its byte limit');
  }
  return context;
}

/**
 * Deliver the prompt through a bounded pipe and settle only after Node reports
 * that all buffered bytes were flushed. EPIPE, premature close, and abort are
 * converted into ordinary promise rejections instead of unhandled stream errors.
 */
export function writeCodexPromptToStdin(
  stdin: Writable | null,
  prompt: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!stdin) {
    return Promise.reject(
      new Error('CodexEngine: Codex stdin pipe was not created'),
    );
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      stdin.removeListener('error', handleError);
      stdin.removeListener('finish', handleFinish);
      stdin.removeListener('close', handleClose);
      signal?.removeEventListener('abort', handleAbort);
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const handleError = (error: Error): void => {
      settle(
        new Error(
          `CodexEngine: failed to write prompt to stdin: ${error.message}`,
        ),
      );
    };
    const handleFinish = (): void => settle();
    const handleClose = (): void => {
      if (stdin.writableFinished) {
        settle();
      } else {
        settle(
          new Error(
            'CodexEngine: stdin closed before the prompt was delivered',
          ),
        );
      }
    };
    const handleAbort = (): void => {
      // Do not destroy with an Error: after cleanup that could become an
      // unhandled 'error' event on some Writable implementations.
      settle(new Error('CodexEngine: execution was cancelled'));
      stdin.destroy();
    };

    stdin.once('error', handleError);
    stdin.once('finish', handleFinish);
    stdin.once('close', handleClose);
    signal?.addEventListener('abort', handleAbort, { once: true });

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    try {
      // Writable.end() honours backpressure and 'finish' is emitted only after
      // the buffered prompt has been handed to the underlying pipe.
      stdin.end(prompt, 'utf8');
    } catch (error) {
      handleError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

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

export function buildCodexSpawnSpec(
  repoPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; shell: false } {
  return {
    command: resolveTrustedExecutable('codex', {
      env,
      untrustedCwd: repoPath,
    }),
    // Keep user-controlled prompt text out of cmd.exe command parsing.
    shell: false,
  };
}

/** Preserve defaults when a partial runtime config contains explicit undefined values. */
export function resolveCodexConfig(
  overrides?: Partial<CodexEngineConfig>,
): CodexEngineConfig {
  if (!overrides) return { ...DEFAULT_CODEX_CONFIG };
  const definedOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<CodexEngineConfig>;
  return { ...DEFAULT_CODEX_CONFIG, ...definedOverrides };
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

  async initializeAndRun(
    options: EngineInitOptions,
    ctx: EngineExecutionContext,
  ): Promise<void> {
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

    const instructionBytes = utf8ByteLength(instruction);
    if (instructionBytes > AGENT_FINAL_PROMPT_MAX_BYTES) {
      throw new Error(
        `CodexEngine: instruction exceeds the ${AGENT_FINAL_PROMPT_MAX_BYTES}-byte UTF-8 limit`,
      );
    }

    const normalizedInstruction = instruction.trim();
    if (!normalizedInstruction) {
      throw new Error('CodexEngine: instruction must not be empty');
    }

    // Merge user config with defaults
    const resolvedConfig = resolveCodexConfig(codexConfig);

    const configError = validateCodexConfig(resolvedConfig);
    if (configError) {
      throw new Error(`CodexEngine: ${configError}`);
    }

    // Validate the configured value before trim can copy or hide an oversized
    // whitespace prefix. Blank values retain the documented default.
    assertCodexAutoInstructionsLimit(resolvedConfig.autoInstructions);
    const normalizedAutoInstructions =
      resolvedConfig.autoInstructions.trim() || CODEX_AUTO_INSTRUCTIONS;
    // Validate and escape this component before any project I/O. The aggregate
    // prompt is checked separately once the optional context is available.
    const autoInstructionsBlock = buildCodexAutoInstructionsBlock(
      normalizedAutoInstructions,
    );

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

    const projectContext = resolvedConfig.appendProjectContext
      ? await this.loadProjectContext(repoPath)
      : '';
    const prompt = composeCodexPromptParts(
      autoInstructionsBlock,
      normalizedInstruction,
      projectContext,
    );

    const codexEnv = this.buildCodexEnv();
    const spawnSpec = buildCodexSpawnSpec(repoPath, codexEnv);
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
      args.push(
        '-c',
        `mcp_servers.webpage_mcp.command=${JSON.stringify(stdioConfig.command)}`,
      );
      args.push(
        '-c',
        `mcp_servers.webpage_mcp.args=${JSON.stringify(stdioConfig.args)}`,
      );
      if (stdioConfig.env && Object.keys(stdioConfig.env).length > 0) {
        args.push(
          '-c',
          `mcp_servers.webpage_mcp.env=${JSON.stringify(stdioConfig.env)}`,
        );
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
    const hasResolvedPaths =
      resolvedImagePaths && resolvedImagePaths.length > 0;

    if (hasResolvedPaths) {
      // Use pre-resolved persistent paths (preferred - no temp files needed)
      console.error(
        `[CodexEngine] Using ${resolvedImagePaths.length} pre-resolved image path(s)`,
      );
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
            console.error(
              '[CodexEngine] Failed to write attachment to temp file:',
              err,
            );
          }
        }
      }
    }

    // `codex exec -` consumes the prompt from stdin. Never place user content
    // in argv where it is visible to process listings and constrained by OS
    // command-line limits.
    args.push('-');

    // Use explicit Promise wrapping to ensure child process errors are properly rejected.
    return new Promise<void>((resolve, reject) => {
      const child = spawn(spawnSpec.command, args, {
        cwd: repoPath,
        env: codexEnv,
        shell: spawnSpec.shell,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: shouldDetachChildProcess(),
      });

      // State management
      const stderrBuffer: string[] = [];
      let hasCompleted = false;
      let terminalError: Error | null = null;
      let finishPromise: Promise<void> | null = null;
      let promptDeliveryPromise: Promise<void> | null = null;

      // Readline interface - declared early to avoid TDZ issues in finish()
      let rl: readline.Interface | null = null;
      const configuredTimeoutMs = Number.parseInt(
        process.env.CODEX_ENGINE_TIMEOUT_MS || '',
        10,
      );
      const timeoutMs =
        Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
          ? configuredTimeoutMs
          : 15 * 60 * 1000;
      const processLifecycle = new ChildProcessLifecycle(child, {
        signal,
        timeoutMs,
        abortError: () => new Error('CodexEngine: execution was cancelled'),
        timeoutError: () => new Error('CodexEngine: execution timed out'),
        onTerminationRequested: () => {
          try {
            rl?.close();
          } catch {
            // Closing readline is best-effort; process termination remains authoritative.
          }
          try {
            child.stdin?.destroy();
          } catch {
            // Closing stdin is best-effort; process termination remains authoritative.
          }
        },
      });

      // Assistant message state
      let assistantMessageId: string | null = null;
      let assistantCreatedAt: string | null = null;
      const streamedToolHashes = new BoundedSet<string>(
        STREAM_DEDUPE_MAX_ENTRIES,
      );
      const activeCommands = new BoundedMap<string, { command?: string }>(
        STREAM_ACTIVE_COMMAND_MAX_ENTRIES,
      );
      let assistantStream: BoundedAssistantStream | null = null;

      /**
       * Cleanup temporary files created for image attachments.
       */
      const cleanupTempFiles = async (): Promise<void> => {
        if (tempFiles.length === 0) return;

        for (const filePath of tempFiles) {
          try {
            await removePrivateTempAttachment(filePath);
            console.error(`[CodexEngine] Cleaned up temp file: ${filePath}`);
          } catch (err) {
            // Ignore errors during cleanup - file may already be deleted
            console.error(
              `[CodexEngine] Failed to cleanup temp file ${filePath}:`,
              err,
            );
          }
        }
      };

      /**
       * Cleanup and settle the promise (resolve or reject).
       * Waits for temp file cleanup to complete before settling.
       */
      const finish = (error?: unknown): Promise<void> => {
        const normalizedError =
          error === undefined
            ? null
            : error instanceof Error
              ? error
              : new Error(String(error));
        if (normalizedError && !terminalError) {
          terminalError = normalizedError;
        }
        if (normalizedError) {
          processLifecycle.terminate(normalizedError);
        }
        if (finishPromise) return finishPromise;

        finishPromise = (async () => {
          let exit: ChildProcessExit | null = null;
          try {
            exit = await processLifecycle.completion;
          } catch (lifecycleError) {
            if (!terminalError) {
              terminalError =
                lifecycleError instanceof Error
                  ? lifecycleError
                  : new Error(String(lifecycleError));
            }
          }

          if (promptDeliveryPromise) {
            if (child.stdin && !child.stdin.writableFinished) {
              child.stdin.destroy();
            }
            try {
              await promptDeliveryPromise;
            } catch (promptError) {
              if (!terminalError) {
                terminalError =
                  promptError instanceof Error
                    ? promptError
                    : new Error(String(promptError));
              }
            }
          }

          if (
            !terminalError &&
            exit &&
            (exit.code !== 0 || exit.signal !== null)
          ) {
            const detailParts: string[] = [];
            if (typeof exit.code === 'number') {
              detailParts.push(`exit code ${exit.code}`);
            }
            if (exit.signal) {
              detailParts.push(`signal ${exit.signal}`);
            }
            const detail =
              detailParts.length > 0
                ? detailParts.join(', ')
                : 'unexpected shutdown';
            terminalError = new Error(
              `CodexEngine: process terminated (${detail})`,
            );
          }

          // Always flush the last coalesced snapshot before teardown, then clear
          // its timer so no buffered event can outlive this execution.
          try {
            assistantStream?.flushFinal();
          } catch (flushError) {
            if (!terminalError) {
              terminalError =
                flushError instanceof Error
                  ? flushError
                  : new Error(String(flushError));
            }
          } finally {
            assistantStream?.cancel();
          }

          if (rl) {
            try {
              rl.close();
            } catch {
              // Ignore close errors during cleanup.
            }
          }

          // The process is now closed (or never spawned), so temporary files
          // cannot still be in use by Codex.
          await cleanupTempFiles();

          if (terminalError) {
            reject(terminalError);
          } else {
            resolve();
          }
        })();

        return finishPromise;
      };

      // A spawn failure, timeout, cancellation, or ordinary close all converge
      // on the same idempotent finalizer. Lifecycle rejection occurs only after
      // the child has closed, except when spawning never created a process.
      void processLifecycle.completion.then(
        () => {
          void finish();
        },
        (lifecycleError) => {
          void finish(lifecycleError);
        },
      );

      promptDeliveryPromise = writeCodexPromptToStdin(
        child.stdin,
        prompt,
        signal,
      );
      void promptDeliveryPromise.catch((promptError) => {
        // Cancellation/timeout already has a more precise lifecycle error.
        if (!processLifecycle.isTerminationRequested) {
          void finish(promptError);
        }
      });

      // Collect stderr with bounded buffer
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (!text) return;

        stderrBuffer.push(text);
        // Keep only the most recent lines to prevent memory growth
        if (stderrBuffer.length > CodexEngine.MAX_STDERR_LINES) {
          stderrBuffer.splice(
            0,
            stderrBuffer.length - CodexEngine.MAX_STDERR_LINES,
          );
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
        const outputSnapshot = boundStreamText(
          rawOutput,
          STREAM_TOOL_CONTENT_MAX_BYTES,
        );
        const output = outputSnapshot.text;
        const exitCode =
          typeof item.exit_code === 'number' ? item.exit_code : undefined;
        const status = this.pickFirstString(item.status);
        const isError =
          status === 'failed' ||
          (typeof exitCode === 'number' && exitCode !== 0);

        const summary = command ? `Ran: ${command}` : 'Executed shell command';
        const exitSuffix =
          typeof exitCode === 'number' ? ` (exit ${exitCode})` : '';
        const body = output.trim();
        const fullContent = body
          ? `${summary}${exitSuffix}\n\n${body}`
          : `${summary}${exitSuffix}`;

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
          changes: item.changes as
            | Record<string, unknown>
            | Array<Record<string, unknown>>,
        });
        const status = this.pickFirstString(item.status) ?? 'completed';
        const isError = status === 'failed';
        const toolName =
          (metadata?.toolName as string) ||
          (metadata?.tool_name as string) ||
          'Edit';

        dispatchToolMessage(
          isError ? `Failed: ${content}` : content,
          {
            ...metadata,
            toolName,
            tool_name: toolName,
            status,
            is_error: isError || undefined,
          },
          'tool_result',
          false,
        );
      };

      const emitTodoListUpdate = (
        record: Record<string, unknown>,
        phase: TodoListPhase,
      ): void => {
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
              console.warn(
                '[CodexEngine] Failed to parse Codex event line:',
                trimmed,
              );
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
                    this.pickFirstString(
                      (item as Record<string, unknown>).error,
                    )) ||
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
                  this.pickFirstString(
                    (event as { message?: unknown }).message,
                  ) ||
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
      (projectRoot && projectRoot.trim()) ||
      process.env.MCP_AGENT_PROJECT_ROOT ||
      process.cwd();
    return path.resolve(base);
  }

  /**
   * Load project context (file listing) as an independently bounded section.
   * Aligned with other/cweb implementation.
   */
  private async loadProjectContext(repoPath: string): Promise<string> {
    try {
      const fs = await import('node:fs/promises');
      const directory = await fs.opendir(repoPath);
      return await buildCodexProjectContext(directory);
    } catch (error) {
      console.warn('[CodexEngine] Failed to load project context:', error);
      return '';
    }
  }

  /**
   * Build Codex CLI configuration arguments from the resolved config.
   * Aligned with other/cweb implementation for feature parity.
   */
  private buildCodexConfigArgs(config: CodexEngineConfig): string[] {
    const args: string[] = [];

    const pushConfig = (
      key: string,
      value: string | number | boolean,
    ): void => {
      args.push('-c', `${key}=${String(value)}`);
    };

    pushConfig('include_apply_patch_tool', config.includeApplyPatchTool);
    pushConfig('include_plan_tool', config.includePlanTool);
    pushConfig('tools.web_search_request', config.enableWebSearch);
    pushConfig(
      'use_experimental_streamable_shell_tool',
      config.useStreamableShell,
    );
    pushConfig('sandbox_mode', config.sandboxMode);
    pushConfig('max_turns', config.maxTurns);
    pushConfig('max_thinking_tokens', config.maxThinkingTokens);
    pushConfig('reasoning_effort', config.reasoningEffort);

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
    return writePrivateTempAttachment({
      ...attachment,
      type: 'image',
    });
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
      env.PATH = [...extraPaths, currentPath]
        .filter(Boolean)
        .join(path.delimiter);
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

  private buildTodoListContent(
    items: TodoListItem[],
    phase: TodoListPhase,
  ): string {
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
