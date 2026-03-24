import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import type { FlowV3 } from '../record-replay-v3/domain/flow';
import type { JsonValue } from '../record-replay-v3/domain/json';
import type { VariableDefinition } from '../record-replay-v3/domain/variables';
import { createStoragePort } from '../record-replay-v3';
import { saveFlowToV3 } from '../record-replay-v3/compat';
import { findEntryNodeId } from '../record-replay-v3/storage/import/flow-convert';
import { applyFlowParameterSuggestions } from './flow-parameterization';

type FlowHintLevel = 'info' | 'warning';

interface FlowHint {
  level: FlowHintLevel;
  code: string;
  message: string;
  nodeId?: string;
}

function countFlowNodes(flow: FlowV3): number {
  return Array.isArray(flow.nodes) ? flow.nodes.length : 0;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item));
  }
  return false;
}

function normalizeVariableName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeFlowVariables(value: unknown): VariableDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error('variables must be an array');
  }

  const seen = new Set<string>();
  const variables: VariableDefinition[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`variables[${index}] must be an object`);
    }

    const record = item as Record<string, unknown>;
    const name = normalizeVariableName(record.name) || normalizeVariableName(record.key);
    if (!name) {
      throw new Error(`variables[${index}].name is required`);
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate variable name: "${name}"`);
    }
    seen.add(name);

    const variable: VariableDefinition = { name };
    const label = normalizeVariableName(record.label);
    if (label) variable.label = label;
    const description = normalizeVariableName(record.description);
    if (description) variable.description = description;
    if (typeof record.sensitive === 'boolean') variable.sensitive = record.sensitive;
    if (typeof record.required === 'boolean') variable.required = record.required;
    if (record.default !== undefined) {
      if (!isJsonValue(record.default)) {
        throw new Error(`variables[${index}].default must be JSON-serializable`);
      }
      variable.default = record.default;
    }
    if (record.scope !== undefined) {
      if (record.scope !== 'flow' && record.scope !== 'run') {
        throw new Error(`variables[${index}].scope must be "flow" or "run"`);
      }
      variable.scope = record.scope;
    }

    variables.push(variable);
  }

  return variables;
}

function collectFlowHints(flow: FlowV3): FlowHint[] {
  const hints: FlowHint[] = [];
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];

  const hasAssert = nodes.some((node) => node.kind === 'assert');
  if (!hasAssert) {
    hints.push({
      level: 'warning',
      code: 'missing_assertion',
      message: 'No assert node found. Consider adding at least one checkpoint.',
    });
  }

  for (const node of nodes) {
    const target = node?.config && typeof node.config === 'object' ? (node.config as any).target : null;
    const selector = target && typeof target.selector === 'string' ? target.selector : '';
    if (selector) {
      if (selector.includes(':nth-of-type(') || selector.startsWith('/')) {
        hints.push({
          level: 'warning',
          code: 'unstable_selector',
          message: 'Selector may be unstable (structural or XPath). Prefer data-* or aria selectors.',
          nodeId: node.id,
        });
      }
    }

    if (node.kind === 'fill') {
      const value = node?.config && (node.config as any).value;
      if (typeof value === 'string' && value.trim() && !/^\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(value.trim())) {
        hints.push({
          level: 'info',
          code: 'literal_fill_value',
          message: 'Fill value looks literal. Consider converting it to a variable.',
          nodeId: node.id,
        });
      }
    }
  }

  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1];
    const curr = nodes[i];
    if (!prev || !curr) continue;
    const prevSel = (prev.config as any)?.target?.selector || '';
    const currSel = (curr.config as any)?.target?.selector || '';
    if (prev.kind === curr.kind && prevSel && currSel && prevSel === currSel) {
      hints.push({
        level: 'info',
        code: 'possible_redundant_step',
        message: 'Consecutive steps operate on the same selector. Check for redundancy.',
        nodeId: curr.id,
      });
    }
  }

  return hints;
}

class FlowAnalyzeTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_ANALYZE;

  async execute(args: any): Promise<ToolResult> {
    const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    if (!flowId) return createErrorResponse('flowId is required');

    const flow = await createStoragePort().flows.get(flowId as FlowV3['id']);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);

    const hints = collectFlowHints(flow);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            summary: {
              flowId: flow.id,
              name: flow.name,
              nodeCount: countFlowNodes(flow),
              edgeCount: Array.isArray(flow.edges) ? flow.edges.length : 0,
              variableCount: Array.isArray(flow.variables) ? flow.variables.length : 0,
              hintCount: hints.length,
            },
            hints,
            flow,
          }),
        },
      ],
      isError: false,
    };
  }
}

class FlowUpdateTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_UPDATE;

  async execute(args: any): Promise<ToolResult> {
    const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    if (!flowId) return createErrorResponse('flowId is required');

    const flow = await createStoragePort().flows.get(flowId as FlowV3['id']);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);

    let changed = false;

    if (typeof args?.name === 'string') {
      const nextName = args.name.trim();
      if (nextName && nextName !== flow.name) {
        flow.name = nextName;
        changed = true;
      }
    }
    if (typeof args?.description === 'string') {
      const nextDescription = args.description.trim();
      const normalized = nextDescription || undefined;
      if (normalized !== flow.description) {
        flow.description = normalized;
        changed = true;
      }
    }
    if (Array.isArray(args?.nodes)) {
      flow.nodes = args.nodes;
      changed = true;
    }
    if (Array.isArray(args?.edges)) {
      flow.edges = args.edges;
      changed = true;
    }
    if (args && Object.prototype.hasOwnProperty.call(args, 'variables')) {
      try {
        flow.variables = normalizeFlowVariables(args.variables);
      } catch (error) {
        return createErrorResponse(error instanceof Error ? error.message : String(error));
      }
      changed = true;
    }
    const applyParameterSuggestions = args?.applyParameterSuggestions === true;
    let parameterization: ReturnType<typeof applyFlowParameterSuggestions> | undefined;
    if (applyParameterSuggestions) {
      parameterization = applyFlowParameterSuggestions(flow);
      if (parameterization.changed) {
        changed = true;
      }
    }

    if (!changed) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              updated: false,
              flowId,
              ...(parameterization ? { parameterization } : {}),
            }),
          },
        ],
        isError: false,
      };
    }

    if (Array.isArray(args?.nodes) || Array.isArray(args?.edges)) {
      const entry = findEntryNodeId(flow.nodes, flow.edges);
      if (!entry.nodeId) {
        return createErrorResponse('Could not determine a valid entry node for the updated flow');
      }
      flow.entryNodeId = entry.nodeId;
    }

    flow.updatedAt = new Date().toISOString();
    await saveFlowToV3(flow);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            updated: true,
            flow: {
              id: flow.id,
              name: flow.name,
              description: flow.description,
              nodeCount: countFlowNodes(flow),
              edgeCount: Array.isArray(flow.edges) ? flow.edges.length : 0,
              variableCount: Array.isArray(flow.variables) ? flow.variables.length : 0,
            },
            ...(parameterization ? { parameterization } : {}),
          }),
        },
      ],
      isError: false,
    };
  }
}

export const flowAnalyzeTool = new FlowAnalyzeTool();
export const flowUpdateTool = new FlowUpdateTool();
