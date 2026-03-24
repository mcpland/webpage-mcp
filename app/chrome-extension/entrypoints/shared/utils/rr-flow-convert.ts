/**
 * @fileoverview builder-flow/V3 bidirectional conversion utilities
 * @description Bridges builder flow documents with V3 RPC FlowV3 types
 *
 * Design notes:
 * - Builder store currently still uses compatibility flow fields (type, version, steps)
 * - RPC layer uses V3 types (kind, schemaVersion, entryNodeId)
 * - This module provides UI-layer type conversion, wrapping the underlying converter
 */

import type { Flow as BuilderFlow } from "@/common/workflow-compat-types";
import type { FlowV3 } from "@/entrypoints/background/record-replay-v3/domain/flow";
import {
  convertCompatFlowToV3,
  convertFlowV3ToCompat,
} from "@/entrypoints/background/record-replay-v3/storage/import/flow-convert";

// ==================== Types ====================

export interface FlowConversionResult<T> {
  flow: T;
  warnings: string[];
}

// ==================== Builder flow -> V3 (for RPC calls) ====================

/**
 * Convert builder flow to V3 format for RPC saving
 * @param flowV2 Builder flow from the editor store
 * @returns V3 Flow and warning messages
 * @throws Throws error on conversion failure
 */
export function flowBuilderToV3ForRpc(flowV2: BuilderFlow): FlowConversionResult<FlowV3> {
  const result = convertCompatFlowToV3(
    flowV2 as unknown as Parameters<typeof convertCompatFlowToV3>[0],
  );

  if (!result.success || !result.data) {
    const errorMsg =
      result.errors.length > 0
        ? result.errors.join("; ")
        : "Unknown conversion error";
    throw new Error(`Builder→V3 conversion failed: ${errorMsg}`);
  }

  return {
    flow: result.data,
    warnings: result.warnings,
  };
}

// ==================== V3 -> builder flow (for editor display) ====================

/**
 * Convert V3 flow to builder-compatible format for editor display and editing
 * @param flowV3 V3 Flow obtained from RPC
 * @returns Builder-compatible flow and warning messages
 * @throws Throws error on conversion failure
 */
export function flowV3ToBuilderForEditor(
  flowV3: FlowV3,
): FlowConversionResult<BuilderFlow> {
  const result = convertFlowV3ToCompat(flowV3);

  if (!result.success || !result.data) {
    const errorMsg =
      result.errors.length > 0
        ? result.errors.join("; ")
        : "Unknown conversion error";
    throw new Error(`V3→builder conversion failed: ${errorMsg}`);
  }

  return {
    flow: result.data as unknown as BuilderFlow,
    warnings: result.warnings,
  };
}

// ==================== Type Guards ====================

/**
 * Check if value is a V3 Flow
 * @description Used to determine JSON format during import
 */
export function isFlowV3(value: unknown): value is FlowV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return (
    obj.schemaVersion === 3 &&
    typeof obj.id === "string" &&
    typeof obj.name === "string" &&
    typeof obj.entryNodeId === "string" &&
    Array.isArray(obj.nodes)
  );
}

/**
 * Check if value is a builder-compatible flow
 * @description Used to determine JSON format during import
 */
export function isBuilderFlow(value: unknown): value is BuilderFlow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.name === "string" &&
    // Builder-compatible flow has a version field and no schemaVersion
    typeof obj.version === "number" &&
    obj.schemaVersion === undefined &&
    // Builder-compatible flow may have steps or nodes
    (Array.isArray(obj.steps) || Array.isArray(obj.nodes))
  );
}

// ==================== Import Helpers ====================

/**
 * Extract Flow candidates from imported JSON
 * @description Supports single Flow, Flow array, or { flows: Flow[] } format
 */
export function extractFlowCandidates(parsed: unknown): unknown[] {
  // Array format
  if (Array.isArray(parsed)) {
    return parsed;
  }

  // Object format
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;

    // { flows: [...] } format
    if (Array.isArray(obj.flows)) {
      return obj.flows;
    }

    // Single Flow object
    if (obj.id && (Array.isArray(obj.steps) || Array.isArray(obj.nodes))) {
      return [obj];
    }
  }

  return [];
}
