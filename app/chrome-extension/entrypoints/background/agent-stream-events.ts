import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";
import {
  sanitizeAgentStreamRelayPayload,
  type AgentStreamRelayPayload,
} from "@/common/agent-stream-boundaries";

export type AgentStreamListener = (payload: AgentStreamRelayPayload) => void;
const listeners = new Set<AgentStreamListener>();

export function addAgentStreamListener(listener: AgentStreamListener): void {
  listeners.add(listener);
}

export function removeAgentStreamListener(listener: AgentStreamListener): void {
  listeners.delete(listener);
}

/** Chrome broadcasts to other extension contexts, so deliver to worker subscribers locally. */
export async function relayNativeAgentStreamEvent(raw: unknown): Promise<void> {
  const payload = sanitizeAgentStreamRelayPayload(raw);
  if (!payload) return;
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (error) {
      console.warn("Failed to deliver an Agent stream event", error);
    }
  }
  try {
    await chrome.runtime.sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_EVENT,
      payload,
    });
  } catch {
    // A separate extension page may not be open to receive the broadcast.
  }
}
