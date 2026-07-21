/**
 * Native RPC Runtime - no HTTP server.
 *
 * Responsibilities:
 * - Agent service composition
 * - Native host binding
 * - Agent RPC dispatch
 * - Session stream subscription management
 * - Lifecycle management
 */
import { TIMEOUTS, ERROR_MESSAGES } from '../constant';
import { AgentStreamManager } from '../agent/stream-manager';
import { AgentChatService } from '../agent/chat-service';
import { CodexEngine } from '../agent/engines/codex';
import { ClaudeEngine } from '../agent/engines/claude';
import { closeDb } from '../agent/db';
import type { RealtimeEvent } from '../agent/types';
import { dispatchAgentRpc, type RpcDispatchResponse } from '../agent/rpc-dispatcher';
import {
  DEFAULT_MCP_INSTANCE_ID,
  type AgentRpcRequestPayload,
} from 'webpage-mcp-shared';
import { resolveInstanceId } from '../instance-id';

interface ServerOptions {
  instanceId?: string;
}

export type InternalRouteResponse = RpcDispatchResponse;

export class Server {
  private static activeServerCount = 0;
  public isRunning = false;
  public readonly instanceId: string;
  private countedAsActive = false;
  private stopPromise: Promise<void> | null = null;
  private nativeHost: {
    sendRequestToExtensionAndWait: (
      messagePayload: unknown,
      messageType?: string,
      timeoutMs?: number,
    ) => Promise<unknown>;
  } | null = null;
  private agentStreamManager: AgentStreamManager;
  private agentChatService: AgentChatService;

  constructor(options: ServerOptions = {}) {
    this.instanceId = resolveInstanceId(options.instanceId);
    this.agentStreamManager = new AgentStreamManager();
    this.agentChatService = new AgentChatService({
      engines: [new CodexEngine(this.instanceId), new ClaudeEngine(this.instanceId)],
      streamManager: this.agentStreamManager,
    });
  }

  public setNativeHost(nativeHost: {
    sendRequestToExtensionAndWait: (
      messagePayload: unknown,
      messageType?: string,
      timeoutMs?: number,
    ) => Promise<unknown>;
  }): void {
    this.nativeHost = nativeHost;
  }

  public async invokeAgentRpc(request: AgentRpcRequestPayload): Promise<InternalRouteResponse> {
    if (!this.isRunning) {
      throw new Error(ERROR_MESSAGES.SERVER_NOT_RUNNING);
    }
    return dispatchAgentRpc(request, {
      chatService: this.agentChatService,
      requestExtension: async (payload) => {
        if (!this.nativeHost) {
          throw new Error(ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE);
        }
        if (!this.isRunning) {
          throw new Error(ERROR_MESSAGES.SERVER_NOT_RUNNING);
        }
        return this.nativeHost.sendRequestToExtensionAndWait(
          payload,
          'process_data',
          TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
        );
      },
    });
  }

  public subscribeAgentEvents(
    sessionId: string,
    listener: (event: RealtimeEvent) => void,
  ): () => void {
    this.agentStreamManager.addListener(sessionId, listener);
    return () => {
      this.agentStreamManager.removeListener(sessionId, listener);
    };
  }

  public async start(nativeHost: {
    sendRequestToExtensionAndWait: (
      messagePayload: unknown,
      messageType?: string,
      timeoutMs?: number,
    ) => Promise<unknown>;
  }): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
    }
    if (this.countedAsActive && !this.isRunning) {
      await this.stop();
    }
    if (!this.nativeHost || this.nativeHost !== nativeHost) {
      this.nativeHost = nativeHost;
    }

    if (this.isRunning) {
      return;
    }

    this.agentChatService.resumeExecutionAdmission();
    this.isRunning = true;
    this.countedAsActive = true;
    Server.activeServerCount += 1;
  }

  public async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.isRunning = false;
    const shutdown = (async () => {
      await this.agentChatService.cancelAndAwaitAllExecutions();
      if (!this.countedAsActive) return;
      this.countedAsActive = false;
      Server.activeServerCount = Math.max(0, Server.activeServerCount - 1);
      if (Server.activeServerCount === 0) {
        closeDb();
      }
    })();
    const tracked = shutdown.finally(() => {
      if (this.stopPromise === tracked) this.stopPromise = null;
    });
    this.stopPromise = tracked;
    return tracked;
  }
}

const serverInstance = new Server({ instanceId: DEFAULT_MCP_INSTANCE_ID });
export default serverInstance;
