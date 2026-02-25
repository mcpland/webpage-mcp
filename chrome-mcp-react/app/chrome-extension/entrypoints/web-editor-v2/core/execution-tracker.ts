/**
 * Execution Tracker (Phase 3.10)
 *
 * Tracks Agent execution status for Apply operations via background polling.
 * Provides real-time feedback on execution progress without requiring SSE.
 *
 * Design:
 * - Uses message passing to background for status queries
 * - Lightweight polling approach (avoids complexity of SSE in content script)
 * - Disposer pattern for cleanup
 */

import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { Disposer } from '../utils/disposables';

// =============================================================================
// Types
// =============================================================================

/**
 * Execution status phases.
 * Note: 'error' is included for compatibility with AgentStatusEvent from server.
 * Both 'error' and 'failed' are treated as terminal failure states.
 */
export type ExecutionStatus =
  | 'pending'
  | 'starting'
  | 'running'
  | 'locating'
  | 'applying'
  | 'completed'
  | 'failed'
  | 'error' // Agent server uses 'error', we accept both
  | 'timeout'
  | 'cancelled';

/** Execution state */
export interface ExecutionState {
  requestId: string;
  sessionId: string;
  status: ExecutionStatus;
  message?: string;
  startedAt: number;
  updatedAt: number;
  result?: {
    success: boolean;
    summary?: string;
    error?: string;
  };
}

/** Status update callback */
export type StatusCallback = (state: ExecutionState) => void;

/** Tracker options */
export interface ExecutionTrackerOptions {
  /** Polling interval in ms (default: 2000) */
  pollInterval?: number;
  /** Timeout for execution in ms (default: 120000 = 2 min) */
  timeout?: number;
  /** Callback when status changes */
  onStatusChange?: StatusCallback;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_POLL_INTERVAL = 2000;
const DEFAULT_TIMEOUT = 120000;

// Terminal statuses that stop polling
// Note: 'error' is included for compatibility with AgentStatusEvent
const TERMINAL_STATUSES: ExecutionStatus[] = [
  'completed',
  'failed',
  'error',
  'timeout',
  'cancelled',
];

// =============================================================================
// Helpers
// =============================================================================

function isTerminalStatus(status: ExecutionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function getStatusMessage(status: ExecutionStatus): string {
  switch (status) {
    case 'pending':
      return 'Waiting...';
    case 'starting':
      return 'Starting Agent...';
    case 'running':
      return 'Running...';
    case 'locating':
      return 'Locating code...';
    case 'applying':
      return 'Applying changes...';
    case 'completed':
      return 'Completed';
    case 'failed':
    case 'error': // Agent server uses 'error', treat same as 'failed'
      return 'Failed';
    case 'timeout':
      return 'Timed out';
    case 'cancelled':
      return 'Cancelled';
    default:
      return '';
  }
}

// =============================================================================
// ExecutionTracker Class
// =============================================================================

export class ExecutionTracker {
  private disposer = new Disposer();
  private executions = new Map<string, ExecutionState>();
  private pollTimers = new Map<string, number>();
  private pollInterval: number;
  private timeout: number;
  private onStatusChange?: StatusCallback;

  constructor(options: ExecutionTrackerOptions = {}) {
    this.pollInterval = options.pollInterval ?? DEFAULT_POLL_INTERVAL;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.onStatusChange = options.onStatusChange;

    this.disposer.add(() => this.stopAllPolling());
  }

  /**
   * Track a new execution by requestId
   */
  track(requestId: string, sessionId: string): ExecutionState {
    const now = Date.now();
    const state: ExecutionState = {
      requestId,
      sessionId,
      status: 'pending',
      message: getStatusMessage('pending'),
      startedAt: now,
      updatedAt: now,
    };

    this.executions.set(requestId, state);
    this.startPolling(requestId);

    return state;
  }

  /**
   * Get current state for a request
   */
  getState(requestId: string): ExecutionState | undefined {
    return this.executions.get(requestId);
  }

  /**
   * Cancel tracking for a request.
   * Sends a real cancel request to the background to abort the execution on the server.
   * @returns Promise that resolves when cancel is complete (or fails silently)
   */
  async cancel(requestId: string): Promise<void> {
    const state = this.executions.get(requestId);
    if (!state) return;

    // Stop polling immediately
    this.stopPolling(requestId);

    // Don't cancel if already in terminal state
    if (isTerminalStatus(state.status)) return;

    // Update local state immediately for responsive UI
    this.updateState(requestId, {
      status: 'cancelled',
      message: 'Cancelling...',
    });

    // Send cancel request to background
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CANCEL_EXECUTION,
        payload: {
          sessionId: state.sessionId,
          requestId: state.requestId,
        },
      });

      // Update message based on response
      if (response?.success) {
        this.updateState(requestId, {
          status: 'cancelled',
          message: 'Cancelled by user',
        });
      } else {
        // Cancel request failed, but we still mark as cancelled locally
        console.warn('[ExecutionTracker] Cancel request failed:', response?.error);
        this.updateState(requestId, {
          status: 'cancelled',
          message: 'Cancelled (server may still be running)',
        });
      }
    } catch (error) {
      // Network/extension error, still mark as cancelled locally
      console.warn('[ExecutionTracker] Cancel request error:', error);
      this.updateState(requestId, {
        status: 'cancelled',
        message: 'Cancelled by user',
      });
    }
  }

  /**
   * Manually update status (for background message handler)
   */
  updateFromBackground(
    requestId: string,
    update: {
      status: ExecutionStatus;
      message?: string;
      result?: ExecutionState['result'];
    },
  ): void {
    this.updateState(requestId, update);
  }

  /**
   * Clean up
   */
  dispose(): void {
    this.disposer.dispose();
    this.executions.clear();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private startPolling(requestId: string): void {
    // Check for timeout
    const timeoutTimer = window.setTimeout(() => {
      const state = this.executions.get(requestId);
      if (state && !isTerminalStatus(state.status)) {
        this.updateState(requestId, {
          status: 'timeout',
          message: 'Execution timed out',
        });
        this.stopPolling(requestId);
      }
    }, this.timeout);

    this.disposer.add(() => window.clearTimeout(timeoutTimer));

    // Start polling
    const poll = async () => {
      const state = this.executions.get(requestId);
      if (!state || isTerminalStatus(state.status)) {
        this.stopPolling(requestId);
        return;
      }

      try {
        const result = await this.queryStatus(requestId, state.sessionId);
        if (result) {
          this.updateState(requestId, result);
          if (isTerminalStatus(result.status)) {
            this.stopPolling(requestId);
            return;
          }
        }
      } catch {
        // Ignore polling errors, will retry
      }

      // Schedule next poll if not disposed
      if (!this.disposer.isDisposed) {
        const timer = window.setTimeout(poll, this.pollInterval);
        this.pollTimers.set(requestId, timer);
      }
    };

    // Initial poll after a short delay
    const initialTimer = window.setTimeout(poll, 500);
    this.pollTimers.set(requestId, initialTimer);
  }

  private stopPolling(requestId: string): void {
    const timer = this.pollTimers.get(requestId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.pollTimers.delete(requestId);
    }
  }

  private stopAllPolling(): void {
    for (const timer of this.pollTimers.values()) {
      window.clearTimeout(timer);
    }
    this.pollTimers.clear();
  }

  private updateState(
    requestId: string,
    update: Partial<Pick<ExecutionState, 'status' | 'message' | 'result'>>,
  ): void {
    const state = this.executions.get(requestId);
    if (!state) return;

    const newState: ExecutionState = {
      ...state,
      ...update,
      updatedAt: Date.now(),
    };

    // Auto-generate message if not provided
    if (update.status && !update.message) {
      newState.message = getStatusMessage(update.status);
    }

    this.executions.set(requestId, newState);
    this.onStatusChange?.(newState);
  }

  private async queryStatus(
    requestId: string,
    sessionId: string,
  ): Promise<{
    status: ExecutionStatus;
    message?: string;
    result?: ExecutionState['result'];
  } | null> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_STATUS_QUERY,
        requestId,
        sessionId,
      });

      if (response?.status) {
        return {
          status: response.status as ExecutionStatus,
          message: response.message,
          result: response.result,
        };
      }
    } catch {
      // Extension context invalidated or other error
    }

    return null;
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an ExecutionTracker instance
 */
export function createExecutionTracker(options?: ExecutionTrackerOptions): ExecutionTracker {
  return new ExecutionTracker(options);
}
