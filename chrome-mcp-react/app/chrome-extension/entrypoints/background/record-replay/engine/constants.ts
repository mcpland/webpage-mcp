// constants.ts — centralized engine constants and labels
import { EDGE_LABELS } from 'webpage-mcp-shared';

export const ENGINE_CONSTANTS = {
  DEFAULT_WAIT_MS: 5000,
  MAX_WAIT_MS: 120000,
  NETWORK_IDLE_SAMPLE_MS: 1200,
  MAX_ITERATIONS: 1000,
  MAX_FOREACH_CONCURRENCY: 16,
  EDGE_LABELS: EDGE_LABELS,
} as const;

export type EdgeLabel =
  (typeof ENGINE_CONSTANTS.EDGE_LABELS)[keyof typeof ENGINE_CONSTANTS.EDGE_LABELS];

// Centralized stepId values used in run logs for non-step events
export const LOG_STEP_IDS = {
  GLOBAL_TIMEOUT: 'global-timeout',
  PLUGIN_RUN_START: 'plugin-runStart',
  VARIABLE_COLLECT: 'variable-collect',
  BINDING_CHECK: 'binding-check',
  NETWORK_CAPTURE: 'network-capture',
  DAG_REQUIRED: 'dag-required',
  DAG_CYCLE: 'dag-cycle',
  LOOP_GUARD: 'loop-guard',
  PLUGIN_RUN_END: 'plugin-runEnd',
  RUNSTATE_UPDATE: 'runState-update',
  RUNSTATE_DELETE: 'runState-delete',
} as const;

export type LogStepId = (typeof LOG_STEP_IDS)[keyof typeof LOG_STEP_IDS];
