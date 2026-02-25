/**
 * @fileoverview V2/V3 Flow bidirectional conversion utilities
 * @description Bridges Builder V2 Flow types with V3 RPC FlowV3 types
 *
 * Design notes:
 * - Builder store currently still uses V2 types (type, version, steps)
 * - RPC layer uses V3 types (kind, schemaVersion, entryNodeId)
 * - This module provides UI-layer type conversion, wrapping the underlying converter
 */

import type { Flow as FlowV2 } from "@/entrypoints/background/record-replay/types";
import type { FlowV3 } from "@/entrypoints/background/record-replay-v3/domain/flow";
import {
  convertFlowV2ToV3,
  convertFlowV3ToV2,
} from "@/entrypoints/background/record-replay-v3/storage/import/v2-to-v3";

// ==================== Types ====================

export interface FlowConversionResult<T> {
  flow: T;
  warnings: string[];
}

// ==================== V2 -> V3 (for RPC calls) ====================

/**
 * Convert V2 Flow to V3 format for RPC saving
 * @param flowV2 V2 Flow from Builder store
 * @returns V3 Flow and warning messages
 * @throws Throws error on conversion failure
 */
export function flowV2ToV3ForRpc(flowV2: FlowV2): FlowConversionResult<FlowV3> {
  const result = convertFlowV2ToV3(
    flowV2 as unknown as Parameters<typeof convertFlowV2ToV3>[0],
  );

  if (!result.success || !result.data) {
    const errorMsg =
      result.errors.length > 0
        ? result.errors.join("; ")
        : "Unknown conversion error";
    throw new Error(`V2→V3 conversion failed: ${errorMsg}`);
  }

  return {
    flow: result.data,
    warnings: result.warnings,
  };
}

// ==================== V3 -> V2 (for Builder display) ====================

/**
 * Convert V3 Flow to V2 format for Builder display and editing
 * @param flowV3 V3 Flow obtained from RPC
 * @returns V2 Flow and warning messages
 * @throws Throws error on conversion failure
 */
export function flowV3ToV2ForBuilder(
  flowV3: FlowV3,
): FlowConversionResult<FlowV2> {
  const result = convertFlowV3ToV2(flowV3);

  if (!result.success || !result.data) {
    const errorMsg =
      result.errors.length > 0
        ? result.errors.join("; ")
        : "Unknown conversion error";
    throw new Error(`V3→V2 conversion failed: ${errorMsg}`);
  }

  return {
    flow: result.data as unknown as FlowV2,
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
 * Check if value is a V2 Flow
 * @description Used to determine JSON format during import
 */
export function isFlowV2(value: unknown): value is FlowV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.name === "string" &&
    // V2 has a version field (number) and no schemaVersion
    typeof obj.version === "number" &&
    obj.schemaVersion === undefined &&
    // V2 may have steps or nodes
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
