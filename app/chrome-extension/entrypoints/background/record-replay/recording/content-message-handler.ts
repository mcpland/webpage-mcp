import type { RecordingSessionManager } from './session-manager';
import type { Step, VariableDef } from '../types';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';

/**
 * Initialize the content message handler for receiving steps and variables from content scripts.
 *
 * Supports the following payload kinds:
 * - 'steps' | 'step': Append steps to the current flow
 * - 'variables': Append variables to the current flow (for sensitive input handling)
 * - 'finalize': Content script has finished flushing (used during stop barrier)
 */
export function initContentMessageHandler(session: RecordingSessionManager): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (!message || message.type !== TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT) return false;

      // Accept messages during 'recording' or 'stopping' states
      // 'stopping' allows final steps to arrive during the drain phase
      if (!session.canAcceptSteps()) {
        sendResponse({ ok: true, ignored: true });
        return true;
      }

      const flow = session.getFlow();
      if (!flow) {
        sendResponse({ ok: true, ignored: true });
        return true;
      }

      const payload = message?.payload || {};

      // Handle steps
      if (payload.kind === 'steps' || payload.kind === 'step') {
        const steps: Step[] = Array.isArray(payload.steps)
          ? (payload.steps as Step[])
          : payload.step
            ? [payload.step as Step]
            : [];
        if (steps.length > 0) {
          session.appendSteps(steps);
        }
      }

      // Handle variables (for sensitive input handling)
      if (payload.kind === 'variables') {
        const variables: VariableDef[] = Array.isArray(payload.variables)
          ? (payload.variables as VariableDef[])
          : [];
        if (variables.length > 0) {
          session.appendVariables(variables);
        }
      }

      // Handle combined payload (steps + variables in one message)
      if (payload.kind === 'batch') {
        const steps: Step[] = Array.isArray(payload.steps) ? (payload.steps as Step[]) : [];
        const variables: VariableDef[] = Array.isArray(payload.variables)
          ? (payload.variables as VariableDef[])
          : [];
        if (steps.length > 0) {
          session.appendSteps(steps);
        }
        if (variables.length > 0) {
          session.appendVariables(variables);
        }
      }

      // payload.kind === 'start'|'stop'|'finalize' are no-ops here (lifecycle handled elsewhere)
      sendResponse({ ok: true });
      return true;
    } catch (e) {
      console.warn('ContentMessageHandler: processing message failed', e);
      sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      return true;
    }
  });
}
