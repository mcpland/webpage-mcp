/**
 * @fileoverview Port RPC Protocol definition
 * @description Defines the protocol type for communication via chrome.runtime.Port
 */

import type { JsonObject, JsonValue } from "../../domain/json";
import type { RunId } from "../../domain/ids";
import type { RunEvent } from "../../domain/events";

/** Port Name */
export const RR_V3_PORT_NAME = "rr_v3" as const;

/**
 * RPC method name
 */
export type RpcMethod =
  // Query method
  | "rr_v3.listRuns"
  | "rr_v3.getRun"
  | "rr_v3.getEvents"
  // Flow management methods
  | "rr_v3.getFlow"
  | "rr_v3.listFlows"
  | "rr_v3.listPublishedFlows"
  | "rr_v3.saveFlow"
  | "rr_v3.publishFlow"
  | "rr_v3.unpublishFlow"
  | "rr_v3.deleteFlow"
  // Trigger management methods
  | "rr_v3.createTrigger"
  | "rr_v3.updateTrigger"
  | "rr_v3.deleteTrigger"
  | "rr_v3.getTrigger"
  | "rr_v3.listTriggers"
  | "rr_v3.enableTrigger"
  | "rr_v3.disableTrigger"
  | "rr_v3.fireTrigger"
  // Queue management methods
  | "rr_v3.enqueueRun"
  | "rr_v3.listQueue"
  | "rr_v3.cancelQueueItem"
  // Control method
  | "rr_v3.startRun"
  | "rr_v3.cancelRun"
  | "rr_v3.pauseRun"
  | "rr_v3.resumeRun"
  // Debugging method
  | "rr_v3.debug"
  // Subscription method
  | "rr_v3.subscribe"
  | "rr_v3.unsubscribe";

/**
 * RPC request message
 */
export interface RpcRequest {
  type: "rr_v3.request";
  /** Request ID (used to match responses) */
  requestId: string;
  /** method name */
  method: RpcMethod;
  /** parameters */
  params?: JsonObject;
}

/**
 * RPC successful response
 */
export interface RpcResponseOk {
  type: "rr_v3.response";
  /** Corresponding request ID */
  requestId: string;
  ok: true;
  /** Return results */
  result: JsonValue;
}

/**
 * RPC error response
 */
export interface RpcResponseErr {
  type: "rr_v3.response";
  /** Corresponding request ID */
  requestId: string;
  ok: false;
  /** error message */
  error: string;
}

/**
 * RPC response
 */
export type RpcResponse = RpcResponseOk | RpcResponseErr;

/**
 * RPC event push
 */
export interface RpcEventMessage {
  type: "rr_v3.event";
  /** event data */
  event: RunEvent;
}

/**
 * RPC Subscription confirmation
 */
export interface RpcSubscribeAck {
  type: "rr_v3.subscribeAck";
  /** Run ID of the subscription (optional, null means subscribe to all) */
  runId: RunId | null;
}

/**
 * All RPC message types
 */
export type RpcMessage =
  | RpcRequest
  | RpcResponseOk
  | RpcResponseErr
  | RpcEventMessage
  | RpcSubscribeAck;

/**
 * Generate unique request ID
 */
export function generateRequestId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Determine whether the message is an RPC request
 */
export function isRpcRequest(msg: unknown): msg is RpcRequest {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as RpcRequest).type === "rr_v3.request"
  );
}

/**
 * Determine whether the message is an RPC response
 */
export function isRpcResponse(msg: unknown): msg is RpcResponse {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as RpcResponse).type === "rr_v3.response"
  );
}

/**
 * Determine whether the message is an RPC event
 */
export function isRpcEvent(msg: unknown): msg is RpcEventMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as RpcEventMessage).type === "rr_v3.event"
  );
}

/**
 * Create RPC request
 */
export function createRpcRequest(
  method: RpcMethod,
  params?: JsonObject,
): RpcRequest {
  return {
    type: "rr_v3.request",
    requestId: generateRequestId(),
    method,
    params,
  };
}

/**
 * Create successful response
 */
export function createRpcResponseOk(
  requestId: string,
  result: JsonValue,
): RpcResponseOk {
  return {
    type: "rr_v3.response",
    requestId,
    ok: true,
    result,
  };
}

/**
 * Create error response
 */
export function createRpcResponseErr(
  requestId: string,
  error: string,
): RpcResponseErr {
  return {
    type: "rr_v3.response",
    requestId,
    ok: false,
    error,
  };
}

/**
 * Create event message
 */
export function createRpcEventMessage(event: RunEvent): RpcEventMessage {
  return {
    type: "rr_v3.event",
    event,
  };
}
