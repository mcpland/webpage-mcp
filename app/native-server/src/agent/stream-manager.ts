import type { RealtimeEvent } from './types';

type StreamListener = (event: RealtimeEvent) => void;

/**
 * AgentStreamManager manages session-scoped realtime listeners.
 *
 * This runtime is transport-agnostic and does not depend on HTTP/SSE/WebSocket.
 */
export class AgentStreamManager {
  private readonly listeners = new Map<string, Set<StreamListener>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  addListener(sessionId: string, listener: StreamListener): void {
    if (!this.listeners.has(sessionId)) {
      this.listeners.set(sessionId, new Set());
    }
    this.listeners.get(sessionId)!.add(listener);
    this.ensureHeartbeatTimer();
  }

  removeListener(sessionId: string, listener: StreamListener): void {
    const listeners = this.listeners.get(sessionId);
    if (!listeners) {
      return;
    }
    listeners.delete(listener);
    if (listeners.size === 0) {
      this.listeners.delete(sessionId);
    }
    this.stopHeartbeatTimerIfIdle();
  }

  publish(event: RealtimeEvent): void {
    // Heartbeat events are broadcast to all listeners.
    if (event.type === 'heartbeat') {
      this.broadcastToAllListeners(event);
      return;
    }

    // For all other event types, require a sessionId for routing.
    const targetSessionId = this.extractSessionId(event);
    if (!targetSessionId) {
      console.warn('[AgentStreamManager] Dropping event without sessionId:', event.type);
      return;
    }

    this.emitToListeners(targetSessionId, event);
  }

  /**
   * Extract sessionId from event based on event type.
   */
  private extractSessionId(event: RealtimeEvent): string | undefined {
    switch (event.type) {
      case 'message':
        return event.data?.sessionId;
      case 'status':
        return event.data?.sessionId;
      case 'connected':
        return event.data?.sessionId;
      case 'usage':
        return event.data?.sessionId;
      case 'error':
        return event.data?.sessionId;
      default:
        return undefined;
    }
  }

  private emitToListeners(sessionId: string, event: RealtimeEvent): void {
    const listeners = this.listeners.get(sessionId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[AgentStreamManager] Failed to notify listener:', error);
      }
    }
  }

  private broadcastToAllListeners(event: RealtimeEvent): void {
    for (const listeners of this.listeners.values()) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Ignore listener errors during heartbeat broadcast.
        }
      }
    }
  }

  private ensureHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      const heartbeat: RealtimeEvent = {
        type: 'heartbeat',
        data: { timestamp: new Date().toISOString() },
      };
      this.publish(heartbeat);
    }, 25_000);

    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeatTimerIfIdle(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    if (this.listeners.size > 0) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
