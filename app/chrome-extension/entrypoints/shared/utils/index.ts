/**
 * @fileoverview Shared Utilities Index
 * @description Utility functions shared between UI entrypoints
 */

// Flow conversion utilities
export {
  extractHiddenSensitiveVariables,
  flowBuilderToV3ForRpc,
  flowV3ToBuilderForEditor,
  isFlowV3,
  isBuilderFlow,
  extractFlowCandidates,
  mergeHiddenSensitiveVariables,
  type FlowConversionResult,
} from "./rr-flow-convert";

export {
  openWorkflowBuilder,
  type OpenWorkflowBuilderOptions,
} from "./open-workflow-builder";

export { getActiveCurrentWindowTabId } from "./active-tab";
