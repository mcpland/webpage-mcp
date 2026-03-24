import { NODE_TYPES } from '@/common/node-types';

export type VariableType = 'string' | 'number' | 'boolean' | 'enum' | 'array';

export interface VariableDef {
  key: string;
  label?: string;
  sensitive?: boolean;
  default?: any;
  type?: VariableType;
  rules?: { required?: boolean; pattern?: string; enum?: string[] };
}

export type NodeType = (typeof NODE_TYPES)[keyof typeof NODE_TYPES];

export interface NodeBase {
  id: string;
  type: NodeType;
  name?: string;
  disabled?: boolean;
  config?: any;
  ui?: { x: number; y: number };
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface Flow {
  id: string;
  name: string;
  description?: string;
  version: number;
  meta?: {
    createdAt: string;
    updatedAt: string;
    domain?: string;
    tags?: string[];
    bindings?: Array<{ type: 'domain' | 'path' | 'url'; value: string }>;
    tool?: { category?: string; description?: string; published?: boolean; slug?: string };
    exposedOutputs?: Array<{ nodeId: string; as: string }>;
    recording?: {
      originUrl?: string;
      originTitle?: string;
      originTabId?: number;
      browser?: string;
      userAgent?: string;
      startedAt?: string;
      stoppedAt?: string;
      durationMs?: number;
      stepCount?: number;
      parameterSuggestions?: Array<{
        nodeId: string;
        kind: 'fill' | 'navigate';
        suggestedKey: string;
        currentValue: string;
      }>;
    };
    stopBarrier?: {
      ok: boolean;
      sessionId?: string;
      stoppedAt?: string;
      failed?: Array<{
        tabId: number;
        skipped?: boolean;
        reason?: string;
        topTimedOut?: boolean;
        topError?: string;
        subframesFailed?: number;
      }>;
    };
  };
  variables?: VariableDef[];
  steps?: any[];
  nodes?: NodeBase[];
  edges?: Edge[];
  subflows?: Record<string, { nodes: NodeBase[]; edges: Edge[] }>;
}

export interface RunLogEntry {
  stepId: string;
  status: 'success' | 'failed' | 'retrying' | 'warning';
  message?: string;
  tookMs?: number;
  screenshotBase64?: string;
  consoleSnippets?: string[];
  networkSnippets?: Array<{ method: string; url: string; status?: number; ms?: number }>;
  fallbackUsed?: boolean;
  fallbackFrom?: string;
  fallbackTo?: string;
}

export interface RunResult {
  runId: string;
  success: boolean;
  summary: { total: number; success: number; failed: number; tookMs: number };
  url?: string | null;
  outputs?: Record<string, any> | null;
  logs?: RunLogEntry[];
  screenshots?: { onFailure?: string | null };
  paused?: boolean;
  debug?: {
    steps: Array<{
      stepId: string;
      type: string;
      status: 'success' | 'failed' | 'paused';
      tookMs: number;
      tabId?: number;
      error?: string;
      nextLabel?: string;
      nextNodeId?: string;
      screenshotBase64?: string;
      screenshotSimilarity?: number | null;
      screenshotMatched?: boolean;
    }>;
    screenshotBaselines?: Record<string, string>;
  };
}
