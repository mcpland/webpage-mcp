/**
 * @fileoverview Port RPC 协议定义
 * @description 定义通过 chrome.runtime.Port 进行通信的协议类型
 */

import type { JsonObject, JsonValue } from '../../domain/json';
import type { RunId } from '../../domain/ids';
import type { RunEvent } from '../../domain/events';

/** Port 名称 */
export const RR_V3_PORT_NAME = 'rr_v3' as const;

/**
 * RPC 方法名称
 */
export type RpcMethod =
  // 查询方法
  | 'rr_v3.listRuns'
  | 'rr_v3.getRun'
  | 'rr_v3.getEvents'
  // Flow 管理方法
  | 'rr_v3.getFlow'
  | 'rr_v3.listFlows'
  | 'rr_v3.saveFlow'
  | 'rr_v3.deleteFlow'
  // 触发器管理方法
  | 'rr_v3.createTrigger'
  | 'rr_v3.updateTrigger'
  | 'rr_v3.deleteTrigger'
  | 'rr_v3.getTrigger'
  | 'rr_v3.listTriggers'
  | 'rr_v3.enableTrigger'
  | 'rr_v3.disableTrigger'
  | 'rr_v3.fireTrigger'
  // 队列管理方法
  | 'rr_v3.enqueueRun'
  | 'rr_v3.listQueue'
  | 'rr_v3.cancelQueueItem'
  // 控制方法
  | 'rr_v3.startRun'
  | 'rr_v3.cancelRun'
  | 'rr_v3.pauseRun'
  | 'rr_v3.resumeRun'
  // 调试方法
  | 'rr_v3.debug'
  // 订阅方法
  | 'rr_v3.subscribe'
  | 'rr_v3.unsubscribe';

/**
 * RPC 请求消息
 */
export interface RpcRequest {
  type: 'rr_v3.request';
  /** 请求 ID（用于匹配响应） */
  requestId: string;
  /** 方法名 */
  method: RpcMethod;
  /** 参数 */
  params?: JsonObject;
}

/**
 * RPC 成功响应
 */
export interface RpcResponseOk {
  type: 'rr_v3.response';
  /** 对应的请求 ID */
  requestId: string;
  ok: true;
  /** 返回结果 */
  result: JsonValue;
}

/**
 * RPC 错误响应
 */
export interface RpcResponseErr {
  type: 'rr_v3.response';
  /** 对应的请求 ID */
  requestId: string;
  ok: false;
  /** 错误信息 */
  error: string;
}

/**
 * RPC 响应
 */
export type RpcResponse = RpcResponseOk | RpcResponseErr;

/**
 * RPC 事件推送
 */
export interface RpcEventMessage {
  type: 'rr_v3.event';
  /** 事件数据 */
  event: RunEvent;
}

/**
 * RPC 订阅确认
 */
export interface RpcSubscribeAck {
  type: 'rr_v3.subscribeAck';
  /** 订阅的 Run ID（可选，null 表示订阅所有） */
  runId: RunId | null;
}

/**
 * 所有 RPC 消息类型
 */
export type RpcMessage =
  | RpcRequest
  | RpcResponseOk
  | RpcResponseErr
  | RpcEventMessage
  | RpcSubscribeAck;

/**
 * 生成唯一的请求 ID
 */
export function generateRequestId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 判断消息是否为 RPC 请求
 */
export function isRpcRequest(msg: unknown): msg is RpcRequest {
  return typeof msg === 'object' && msg !== null && (msg as RpcRequest).type === 'rr_v3.request';
}

/**
 * 判断消息是否为 RPC 响应
 */
export function isRpcResponse(msg: unknown): msg is RpcResponse {
  return typeof msg === 'object' && msg !== null && (msg as RpcResponse).type === 'rr_v3.response';
}

/**
 * 判断消息是否为 RPC 事件
 */
export function isRpcEvent(msg: unknown): msg is RpcEventMessage {
  return typeof msg === 'object' && msg !== null && (msg as RpcEventMessage).type === 'rr_v3.event';
}

/**
 * 创建 RPC 请求
 */
export function createRpcRequest(method: RpcMethod, params?: JsonObject): RpcRequest {
  return {
    type: 'rr_v3.request',
    requestId: generateRequestId(),
    method,
    params,
  };
}

/**
 * 创建成功响应
 */
export function createRpcResponseOk(requestId: string, result: JsonValue): RpcResponseOk {
  return {
    type: 'rr_v3.response',
    requestId,
    ok: true,
    result,
  };
}

/**
 * 创建错误响应
 */
export function createRpcResponseErr(requestId: string, error: string): RpcResponseErr {
  return {
    type: 'rr_v3.response',
    requestId,
    ok: false,
    error,
  };
}

/**
 * 创建事件消息
 */
export function createRpcEventMessage(event: RunEvent): RpcEventMessage {
  return {
    type: 'rr_v3.event',
    event,
  };
}
