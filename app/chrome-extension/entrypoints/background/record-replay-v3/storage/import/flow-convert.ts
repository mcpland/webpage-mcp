/**
 * @fileoverview compatibility-flow to V3 data converter
 * @description Convert builder-compatible flow data to and from V3 format.
 */

import { stepsToDAG, type RRNode, type RREdge } from "webpage-mcp-shared";
import type {
  FlowV3,
  NodeV3,
  EdgeV3,
  FlowBinding,
  FlowExposedOutput,
  FlowMeta,
  FlowRecordingMeta,
  FlowStopBarrierMeta,
  FlowToolMetadata,
} from "../../domain/flow";
import type { TriggerSpec, UrlMatchRule } from "../../domain/triggers";
import type { VariableDefinition } from "../../domain/variables";
import type { NodeId, FlowId, EdgeId } from "../../domain/ids";
import type {
  ISODateTimeString,
  JsonObject,
  JsonValue,
} from "../../domain/json";
import { FLOW_SCHEMA_VERSION } from "../../domain/flow";
import { V3_UNSUPPORTED_NODE_TYPES } from "@/entrypoints/shared/utils/v3-authoring";
import { NODE_TYPES } from "@/common/node-types";

// ==================== Compatibility flow types ====================

/** Compatibility node type definition */
interface CompatNode {
  id: string;
  type: string;
  name?: string;
  disabled?: boolean;
  config?: Record<string, unknown>;
  ui?: { x: number; y: number };
}

/** Compatibility edge type definition */
interface CompatEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

/** Compatibility variable definition */
interface CompatVariableDef {
  key: string;
  label?: string;
  sensitive?: boolean;
  default?: unknown;
  type?: string;
  options?: unknown[];
  item?: string;
  rules?: { required?: boolean; pattern?: string; enum?: unknown[] };
}

/** Compatibility flow binding */
interface CompatBinding {
  type: "domain" | "path" | "url";
  value: string;
}

/** Compatibility flow definition */
interface CompatFlowDocument {
  id: string;
  name: string;
  description?: string;
  version: number;
  meta?: {
    createdAt?: string;
    updatedAt?: string;
    domain?: string;
    tags?: string[];
    bindings?: CompatBinding[];
    tool?: {
      published?: boolean;
      slug?: string;
      category?: string;
      description?: string;
    };
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
        kind: "fill" | "navigate";
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
  variables?: CompatVariableDef[];
  steps?: ReadonlyArray<unknown>;
  nodes?: CompatNode[];
  edges?: CompatEdge[];
  subflows?: Record<string, { nodes: CompatNode[]; edges: CompatEdge[] }>;
}

// ==================== Conversion Result Types ====================

export interface ConversionResult<T> {
  success: boolean;
  data?: T;
  errors: string[];
  warnings: string[];
}

const VALID_LEGACY_STEP_TYPES = new Set<string>(Object.values(NODE_TYPES));

function normalizeLegacyStepType(type: string): string {
  return VALID_LEGACY_STEP_TYPES.has(type) ? type : NODE_TYPES.SCRIPT;
}

function toJsonValue(input: unknown): JsonValue | undefined {
  if (input === null) {
    return null;
  }

  const inputType = typeof input;
  if (
    inputType === "string" ||
    inputType === "number" ||
    inputType === "boolean"
  ) {
    return input as string | number | boolean;
  }

  if (Array.isArray(input)) {
    const arrayValue: JsonValue[] = [];
    for (const entry of input) {
      const converted = toJsonValue(entry);
      if (converted === undefined) {
        return undefined;
      }
      arrayValue.push(converted);
    }
    return arrayValue;
  }

  if (inputType === "object") {
    const objectValue: JsonObject = {};
    for (const [key, value] of Object.entries(
      input as Record<string, unknown>,
    )) {
      const converted = toJsonValue(value);
      if (converted !== undefined) {
        objectValue[key] = converted;
      }
    }
    return objectValue;
  }

  return undefined;
}

function toJsonObject(input: unknown): JsonObject {
  const converted = toJsonValue(input);
  if (converted && typeof converted === "object" && !Array.isArray(converted)) {
    return converted;
  }
  return {};
}

function normalizeCompatUrlMatchRules(
  rules: Array<{ kind: string; value: string }> | undefined,
): UrlMatchRule[] {
  const list = rules ?? [];
  const normalized: UrlMatchRule[] = [];
  for (const rule of list) {
    const value = String(rule?.value ?? "").trim();
    if (!value) {
      continue;
    }

    const kindRaw = String(rule?.kind ?? "")
      .trim()
      .toLowerCase();
    const kind: UrlMatchRule["kind"] =
      kindRaw === "domain" || kindRaw === "path" || kindRaw === "url"
        ? kindRaw
        : "url";
    normalized.push({ kind, value });
  }
  return normalized;
}

function toCompatNode(node: RRNode): CompatNode {
  return {
    id: node.id,
    type: normalizeLegacyStepType(node.type),
    config: node.config,
  };
}

function toCompatEdge(edge: RREdge): CompatEdge {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    label: edge.label,
  };
}

function filterValidCompatEdges(
  edges: ReadonlyArray<CompatEdge>,
  nodeIds: ReadonlySet<string>,
): CompatEdge[] {
  return edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
}

function normalizeCompatGraph(
  compatFlow: CompatFlowDocument,
): { nodes: CompatNode[]; edges: CompatEdge[]; warnings: string[] } {
  const warnings: string[] = [];
  const compatNodes = Array.isArray(compatFlow.nodes) ? compatFlow.nodes : [];
  const compatEdges = Array.isArray(compatFlow.edges) ? compatFlow.edges : [];

  if (compatNodes.length > 0) {
    return {
      nodes: compatNodes,
      edges: compatEdges,
      warnings,
    };
  }

  const compatSteps = Array.isArray(compatFlow.steps) ? compatFlow.steps : [];
  if (compatSteps.length === 0) {
    return {
      nodes: [],
      edges: compatEdges,
      warnings,
    };
  }

  const dag = stepsToDAG(compatSteps);
  const normalizedNodes = dag.nodes.map((node) => {
    const normalizedNode = toCompatNode(node);
    if (normalizedNode.type !== node.type) {
      warnings.push(
        `Unknown legacy step type "${node.type}" converted to "${normalizedNode.type}" for V3 import`,
      );
    }
    return normalizedNode;
  });
  const nodeIds = new Set(normalizedNodes.map((node) => node.id));
  const normalizedEdges =
    compatEdges.length > 0 ? filterValidCompatEdges(compatEdges, nodeIds) : dag.edges.map(toCompatEdge);

  warnings.push("Converted legacy steps-only workflow into DAG nodes for V3 import");

  return {
    nodes: normalizedNodes,
    edges: normalizedEdges.length > 0 ? normalizedEdges : dag.edges.map(toCompatEdge),
    warnings,
  };
}

// ==================== Compatibility flow -> V3 conversion ====================

/**
 * Convert compatibility flow to V3 flow
 * @param compatFlow Compatibility flow document
 * @returns Conversion results, including success/failure status, data and error/warning information
 */
export function convertCompatFlowToV3(compatFlow: CompatFlowDocument): ConversionResult<FlowV3> {
  const errors: string[] = [];
  const graph = normalizeCompatGraph(compatFlow);
  const warnings: string[] = [...graph.warnings];
  const compatNodes = graph.nodes;
  const compatEdges = graph.edges;

  // 1. Basic field validation
  if (!compatFlow.id) {
    errors.push("Compatibility flow missing required field: id");
  }
  if (!compatFlow.name) {
    errors.push("Compatibility flow missing required field: name");
  }
  if (compatNodes.length === 0) {
    errors.push("Compatibility flow has no nodes");
  }

  // 2. Check for unsupported features
  if (compatFlow.subflows && Object.keys(compatFlow.subflows).length > 0) {
    errors.push(
      "V3 does not support subflows yet. Flow contains subflows: " +
        Object.keys(compatFlow.subflows).join(", "),
    );
  }

  // Check foreach/while nodes
  const unsupportedNodes = compatNodes.filter((n) =>
    V3_UNSUPPORTED_NODE_TYPES.includes(
      n.type as (typeof V3_UNSUPPORTED_NODE_TYPES)[number],
    ),
  );
  if (unsupportedNodes.length > 0) {
    errors.push(
      "V3 does not support these node types yet. Found: " +
        unsupportedNodes.map((n) => `${n.id} (${n.type})`).join(", "),
    );
  }

  // If there is a fatal error, return directly
  if (errors.length > 0) {
    return { success: false, errors, warnings };
  }

  // 3. Transform node
  const nodes: NodeV3[] = [];
  for (const compatNode of compatNodes) {
    const node = convertCompatNodeToV3(compatNode);
    if (node) {
      nodes.push(node);
    } else {
      warnings.push(`Skipped invalid node: ${compatNode.id}`);
    }
  }

  // 4. Convert edges
  const edges: EdgeV3[] = [];
  for (const compatEdge of compatEdges) {
    const edge = convertCompatEdgeToV3(compatEdge);
    if (edge) {
      edges.push(edge);
    } else {
      warnings.push(`Skipped invalid edge: ${compatEdge.id}`);
    }
  }

  // 5. Calculate entryNodeId
  const entryResult = findEntryNodeId(nodes, edges);
  warnings.push(...entryResult.warnings);
  if (!entryResult.nodeId) {
    errors.push("Could not determine entry node. No valid root node found.");
    return { success: false, errors, warnings };
  }
  const entryNodeId = entryResult.nodeId;

  // 6. Transform variables
  const variables = convertCompatVariablesToV3(compatFlow.variables || []);

  // 7. Convert metadata
  const meta = convertCompatMetaToV3(compatFlow.meta);

  // 8. Building V3 Flow
  const now = new Date().toISOString() as ISODateTimeString;
  const v3Flow: FlowV3 = {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id: compatFlow.id as FlowId,
    name: compatFlow.name,
    createdAt: (compatFlow.meta?.createdAt as ISODateTimeString) || now,
    updatedAt: (compatFlow.meta?.updatedAt as ISODateTimeString) || now,
    entryNodeId,
    nodes,
    edges,
  };

  // optional fields
  if (compatFlow.description) {
    v3Flow.description = compatFlow.description;
  }
  if (variables.length > 0) {
    v3Flow.variables = variables;
  }
  if (meta) {
    v3Flow.meta = meta;
  }

  return { success: true, data: v3Flow, errors, warnings };
}

/**
 * Convert a single compatibility node to a V3 node
 */
function convertCompatNodeToV3(compatNode: CompatNode): NodeV3 | null {
  if (!compatNode.id || !compatNode.type) {
    return null;
  }

  const node: NodeV3 = {
    id: compatNode.id as NodeId,
    kind: compatNode.type, // Builder type -> V3 kind
    config: toJsonObject(compatNode.config),
  };

  // optional fields
  if (compatNode.name) {
    node.name = compatNode.name;
  }
  if (compatNode.disabled) {
    node.disabled = compatNode.disabled;
  }
  if (compatNode.ui) {
    node.ui = compatNode.ui;
  }

  return node;
}

/**
 * Convert a single compatibility edge to a V3 edge
 */
function convertCompatEdgeToV3(compatEdge: CompatEdge): EdgeV3 | null {
  if (!compatEdge.id || !compatEdge.from || !compatEdge.to) {
    return null;
  }

  const edge: EdgeV3 = {
    id: compatEdge.id as EdgeId,
    from: compatEdge.from as NodeId,
    to: compatEdge.to as NodeId,
  };

  // label pass directly
  if (compatEdge.label) {
    edge.label = compatEdge.label as EdgeV3["label"];
  }

  return edge;
}

/** entryNodeId Calculation result */
export interface EntryNodeResult {
  nodeId: NodeId | null;
  warnings: string[];
}

/**
 * Find entry node ID
 *
 * Rules:
 * 1. Exclude trigger type nodes (these are UI nodes and do not participate in execution)
 * 2. Only count "executable nodes -> Executable node" edge to calculate in-degree (ignore the edge pointed by trigger)
 * 3. Find nodes with indegree 0 as candidates
 * 4. If there are multiple candidates, use stable selection rules:
 *    - Prioritize the node with the upper left UI coordinate (in ascending order by x, in ascending order by y if x is the same)
 *    - If there is no UI coordinate, the first one is taken in dictionary order by ID.
 */
export function findEntryNodeId(
  nodes: ReadonlyArray<NodeV3>,
  edges: ReadonlyArray<EdgeV3>,
): EntryNodeResult {
  const warnings: string[] = [];

  // 1. Exclude the trigger node and obtain the executable node
  const executableNodes = nodes.filter((n) => n.kind !== "trigger");
  if (executableNodes.length === 0) {
    warnings.push("No executable nodes found; cannot determine entry node");
    return { nodeId: null, warnings };
  }

  const executableNodeIds = new Set<NodeId>(executableNodes.map((n) => n.id));

  // 2. Calculate in-degree (only counts edges between executable nodes)
  const inDegree = new Map<NodeId, number>();
  for (const node of executableNodes) {
    inDegree.set(node.id, 0);
  }
  for (const edge of edges) {
    // Ignore edges pointed from non-executable nodes such as triggers
    if (!executableNodeIds.has(edge.from)) {
      continue;
    }
    // Ignore edges pointing to non-executable nodes
    if (!executableNodeIds.has(edge.to)) {
      continue;
    }
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  // 3. Find nodes with degree 0
  const rootNodes = executableNodes.filter((n) => inDegree.get(n.id) === 0);

  if (rootNodes.length === 0) {
    // There is no node with an in-degree of 0, indicating that there is a cycle in the graph. Use the stable selector to select fallback.
    const fallbackResult = selectStableRootNode(executableNodes);
    warnings.push(
      `No inDegree=0 executable node found (graph may contain cycles); ` +
        `falling back to "${fallbackResult.node.id}" by ${fallbackResult.rule}`,
    );
    return { nodeId: fallbackResult.node.id, warnings };
  }

  // 4. Single root node, returned directly
  if (rootNodes.length === 1) {
    return { nodeId: rootNodes[0].id, warnings };
  }

  // 5. Multiple root nodes, using stable selection rules
  const selectedResult = selectStableRootNode(rootNodes);
  const candidateIds = rootNodes
    .map((n) => n.id)
    .sort((a, b) => a.localeCompare(b))
    .join(", ");
  warnings.push(
    `Multiple inDegree=0 executable nodes (${candidateIds}); ` +
      `selected "${selectedResult.node.id}" by ${selectedResult.rule}`,
  );

  return { nodeId: selectedResult.node.id, warnings };
}

/** Stable selection results */
interface StableSelectionResult {
  node: NodeV3;
  rule: string;
}

/**
 * Select a stable entry node from multiple root nodes
 * First press UI coordinates (upper left corner first), secondly press ID dictionary order
 */
function selectStableRootNode(nodes: ReadonlyArray<NodeV3>): StableSelectionResult {
  // Check if the node has valid UI coordinates
  const hasValidUi = (
    n: NodeV3,
  ): n is NodeV3 & { ui: { x: number; y: number } } =>
    !!n.ui && Number.isFinite(n.ui.x) && Number.isFinite(n.ui.y);

  const nodesWithUi = nodes.filter(hasValidUi);

  if (nodesWithUi.length > 0) {
    // Sort by UI coordinate: x ascending -> y Ascending order -> id Lexicographic order (as tie-breaker)
    nodesWithUi.sort((a, b) => {
      if (a.ui.x !== b.ui.x) return a.ui.x - b.ui.x;
      if (a.ui.y !== b.ui.y) return a.ui.y - b.ui.y;
      return a.id.localeCompare(b.id);
    });
    const selected = nodesWithUi[0];
    return {
      node: selected,
      rule: `ui(x=${selected.ui.x}, y=${selected.ui.y})`,
    };
  }

  // No UI coordinates, dictionary order by ID
  const sortedById = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  return { node: sortedById[0], rule: "id" };
}

/**
 * Conversion variable definition
 */
function convertCompatVariablesToV3(
  compatVariables: CompatVariableDef[],
): VariableDefinition[] {
  return compatVariables
    .filter((v) => v.key)
    .map((v) => {
      const variable: VariableDefinition = {
        name: v.key,
      };

      if (v.label) {
        variable.label = v.label;
      }
      if (v.sensitive) {
        variable.sensitive = v.sensitive;
      }
      if (v.default !== undefined) {
        const convertedDefault = toJsonValue(v.default);
        if (convertedDefault !== undefined) {
          variable.default = convertedDefault;
        }
      }
      if (
        v.type === "string" ||
        v.type === "number" ||
        v.type === "boolean" ||
        v.type === "json" ||
        v.type === "enum" ||
        v.type === "array"
      ) {
        variable.kind = v.type;
      }
      if (Array.isArray(v.options)) {
        variable.options = v.options
          .map((option) => toJsonValue(option))
          .filter((option): option is JsonValue => option !== undefined);
        variable.kind = "enum";
      }
      if (
        v.item === "string" ||
        v.item === "number" ||
        v.item === "boolean" ||
        v.item === "json"
      ) {
        variable.item = v.item;
        if (!variable.kind) {
          variable.kind = "array";
        }
      }
      if (v.rules?.required) {
        variable.required = v.rules.required;
      }
      if (Array.isArray(v.rules?.enum)) {
        variable.options = v.rules.enum
          .map((option) => toJsonValue(option))
          .filter((option): option is JsonValue => option !== undefined);
        variable.kind = "enum";
      }

      return variable;
    });
}

function dedupeBindings(bindings: FlowBinding[]): FlowBinding[] {
  const seen = new Set<string>();
  const next: FlowBinding[] = [];

  for (const binding of bindings) {
    const key = `${binding.kind}:${binding.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(binding);
  }

  return next;
}

/**
 * Convert metadata
 */
function convertCompatMetaToV3(compatMeta: CompatFlowDocument["meta"]): FlowV3["meta"] | undefined {
  if (!compatMeta) return undefined;

  const meta: FlowMeta = {};

  if (compatMeta.domain?.trim()) {
    meta.domain = compatMeta.domain.trim();
  }

  if (compatMeta.tags && compatMeta.tags.length > 0) {
    meta.tags = compatMeta.tags;
  }

  const bindings: FlowBinding[] = [];
  if (compatMeta.bindings && compatMeta.bindings.length > 0) {
    bindings.push(
      ...compatMeta.bindings.map((b) => ({
        kind: b.type,
        value: b.value,
      })),
    );
  }
  if (meta.domain) {
    bindings.unshift({
      kind: "domain",
      value: meta.domain,
    });
  }
  if (bindings.length > 0) {
    meta.bindings = dedupeBindings(bindings);
  }

  if (compatMeta.tool) {
    const tool: FlowToolMetadata = {};
    if (typeof compatMeta.tool.published === "boolean") {
      tool.published = compatMeta.tool.published;
    }
    if (typeof compatMeta.tool.slug === "string" && compatMeta.tool.slug.trim()) {
      tool.slug = compatMeta.tool.slug.trim();
    }
    if (
      typeof compatMeta.tool.category === "string" &&
      compatMeta.tool.category.trim()
    ) {
      tool.category = compatMeta.tool.category.trim();
    }
    if (
      typeof compatMeta.tool.description === "string" &&
      compatMeta.tool.description.trim()
    ) {
      tool.description = compatMeta.tool.description.trim();
    }
    if (Object.keys(tool).length > 0) {
      meta.tool = tool;
    }
  }

  if (compatMeta.exposedOutputs?.length) {
    meta.exposedOutputs = compatMeta.exposedOutputs
      .filter((output) => output?.nodeId && output?.as)
      .map(
        (output): FlowExposedOutput => ({
          nodeId: output.nodeId,
          as: output.as,
        }),
      );
  }

  if (compatMeta.recording) {
    const recording: FlowRecordingMeta = {
      ...compatMeta.recording,
      parameterSuggestions: compatMeta.recording.parameterSuggestions?.map(
        (suggestion) => ({
          ...suggestion,
        }),
      ),
    };
    if (Object.keys(recording).length > 0) {
      meta.recording = recording;
    }
  }

  if (compatMeta.stopBarrier) {
    const stopBarrier: FlowStopBarrierMeta = {
      ...compatMeta.stopBarrier,
      failed: compatMeta.stopBarrier.failed?.map((failure) => ({
        ...failure,
      })),
    };
    meta.stopBarrier = stopBarrier;
  }

  // If meta is an empty object, return undefined
  if (Object.keys(meta).length === 0) {
    return undefined;
  }

  return meta;
}

// ==================== V3 -> compatibility-flow conversion ====================

/**
 * Convert V3 flow to a builder-compatible document
 * @param v3Flow V3 Format Flow
 * @returns Conversion result
 */
export function convertFlowV3ToCompat(v3Flow: FlowV3): ConversionResult<CompatFlowDocument> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Transform node
  const nodes: CompatNode[] = v3Flow.nodes.map((n) => ({
    id: n.id,
    type: n.kind, // V3 kind -> builder type
    name: n.name,
    disabled: n.disabled,
    config: n.config as Record<string, unknown>,
    ui: n.ui,
  }));

  // 2. Convert edges
  const edges: CompatEdge[] = v3Flow.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    label: e.label,
  }));

  // 3. Transform variables
  const variables: CompatVariableDef[] = (v3Flow.variables || []).map((v) => ({
    key: v.name,
    label: v.label,
    sensitive: v.sensitive,
    default: v.default,
    type: v.kind,
    options: Array.isArray(v.options) ? [...v.options] : undefined,
    item: v.item,
    rules:
      v.required || (Array.isArray(v.options) && v.options.every((option) => typeof option === "string"))
        ? {
            ...(v.required ? { required: v.required } : {}),
            ...(Array.isArray(v.options) && v.options.every((option) => typeof option === "string")
              ? { enum: [...(v.options as string[])] }
              : {}),
          }
        : undefined,
  }));

  // 4. Convert metadata
  const meta: CompatFlowDocument["meta"] = {
    createdAt: v3Flow.createdAt,
    updatedAt: v3Flow.updatedAt,
  };

  if (v3Flow.meta?.domain) {
    meta.domain = v3Flow.meta.domain;
  } else {
    const domainBinding = v3Flow.meta?.bindings?.find(
      (binding) => binding.kind === "domain",
    );
    if (domainBinding) {
      meta.domain = domainBinding.value;
    }
  }

  if (v3Flow.meta?.tags) {
    meta.tags = v3Flow.meta.tags;
  }

  if (v3Flow.meta?.bindings) {
    meta.bindings = v3Flow.meta.bindings.map((b) => ({
      type: b.kind, // V3 kind -> builder type
      value: b.value,
    }));
  }

  if (v3Flow.meta?.tool) {
    meta.tool = {
      published: v3Flow.meta.tool.published,
      slug: v3Flow.meta.tool.slug,
      category: v3Flow.meta.tool.category,
      description: v3Flow.meta.tool.description,
    };
  }

  if (v3Flow.meta?.exposedOutputs) {
    meta.exposedOutputs = v3Flow.meta.exposedOutputs.map((output) => ({
      nodeId: output.nodeId,
      as: output.as,
    }));
  }

  if (v3Flow.meta?.recording) {
    meta.recording = {
      ...v3Flow.meta.recording,
      parameterSuggestions: v3Flow.meta.recording.parameterSuggestions?.map(
        (suggestion) => ({
          ...suggestion,
        }),
      ),
    };
  }

  if (v3Flow.meta?.stopBarrier) {
    meta.stopBarrier = {
      ...v3Flow.meta.stopBarrier,
      failed: v3Flow.meta.stopBarrier.failed?.map((failure) => ({
        ...failure,
      })),
    };
  }

  // 5. Build compatibility flow
  const compatFlow: CompatFlowDocument = {
    id: v3Flow.id,
    name: v3Flow.name,
    description: v3Flow.description,
    version: 2, // builder version
    meta,
    variables: variables.length > 0 ? variables : undefined,
    nodes,
    edges,
  };

  return { success: true, data: compatFlow, errors, warnings };
}

// ==================== Trigger Conversion ====================

/** Compatibility trigger definition */
interface CompatTrigger {
  id: string;
  type: "url" | "command" | "manual" | "schedule" | "element";
  flowId: string;
  enabled?: boolean;
  match?: Array<{ kind: string; value: string }>;
  title?: string;
  commandKey?: string;
  selector?: string;
  appear?: boolean;
  once?: boolean;
  debounceMs?: number;
  schedule?: {
    type: "interval" | "daily" | "weekly";
    intervalMs?: number;
    time?: string;
    days?: number[];
  };
}

/**
 * Convert a compatibility trigger to V3 TriggerSpec
 * @param compatTrigger Compatibility trigger format
 * @returns Conversion result
 */
export function convertCompatTriggerToV3(
  compatTrigger: CompatTrigger,
): ConversionResult<TriggerSpec> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!compatTrigger.id) {
    errors.push("Compatibility trigger missing required field: id");
  }
  if (!compatTrigger.flowId) {
    errors.push("Compatibility trigger missing required field: flowId");
  }
  if (!compatTrigger.type) {
    errors.push("Compatibility trigger missing required field: type");
  }

  if (errors.length > 0) {
    return { success: false, errors, warnings };
  }

  // Build different TriggerSpec based on type
  let trigger: TriggerSpec;

  switch (compatTrigger.type) {
    case "manual":
      trigger = {
        id: compatTrigger.id,
        kind: "manual",
        flowId: compatTrigger.flowId as FlowId,
        enabled: compatTrigger.enabled ?? true,
      };
      break;

    case "command":
      trigger = {
        id: compatTrigger.id,
        kind: "command",
        flowId: compatTrigger.flowId as FlowId,
        enabled: compatTrigger.enabled ?? true,
        commandKey: compatTrigger.commandKey || "run_workflow",
      };
      break;

    case "url":
      trigger = {
        id: compatTrigger.id,
        kind: "url",
        flowId: compatTrigger.flowId as FlowId,
        enabled: compatTrigger.enabled ?? true,
        match: normalizeCompatUrlMatchRules(compatTrigger.match),
      };
      break;

    case "schedule":
      errors.push(
        "Schedule triggers are no longer supported in Connector scope",
      );
      return { success: false, errors, warnings };

    case "element":
      warnings.push(
        "Element trigger is not fully supported in V3, converting to manual",
      );
      trigger = {
        id: compatTrigger.id,
        kind: "manual",
        flowId: compatTrigger.flowId as FlowId,
        enabled: compatTrigger.enabled ?? true,
      };
      break;

    default:
      errors.push(`Unknown compatibility trigger type: ${compatTrigger.type}`);
      return { success: false, errors, warnings };
  }

  return { success: true, data: trigger, errors, warnings };
}

// ==================== Converter Interface ====================

/**
 * Compatibility-flow to V3 converter interface
 */
export interface CompatToV3Converter {
  /** Convert Flow */
  convertFlow(compatDocument: unknown): FlowV3;
  /** Convert Trigger */
  convertTrigger(triggerDocument: unknown): TriggerSpec;
}

/**
 * Create CompatToV3Converter instance
 */
export function createCompatToV3Converter(): CompatToV3Converter {
  return {
    convertFlow(compatDocument: unknown): FlowV3 {
      const result = convertCompatFlowToV3(compatDocument as CompatFlowDocument);
      if (!result.success || !result.data) {
        throw new Error(`Flow conversion failed: ${result.errors.join("; ")}`);
      }
      return result.data;
    },

    convertTrigger(triggerDocument: unknown): TriggerSpec {
      const result = convertCompatTriggerToV3(triggerDocument as CompatTrigger);
      if (!result.success || !result.data) {
        throw new Error(
          `Trigger conversion failed: ${result.errors.join("; ")}`,
        );
      }
      return result.data;
    },
  };
}

/**
 * Create a deprecated compat converter alias.
 * @deprecated Use createCompatToV3Converter() instead
 */
export function createDeprecatedCompatToV3Converter(): CompatToV3Converter {
  return createCompatToV3Converter();
}
