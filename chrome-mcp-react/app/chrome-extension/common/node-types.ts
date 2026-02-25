// node-types.ts — centralized node type constants for Builder/UI layer
// Combines all executable Step types with UI-only nodes (e.g., trigger, delay)

import { STEP_TYPES } from './step-types';

export const NODE_TYPES = {
  // Executable step types (spread from STEP_TYPES)
  ...STEP_TYPES,
  // UI-only nodes
  TRIGGER: 'trigger',
  DELAY: 'delay',
} as const;

export type NodeTypeConst = (typeof NODE_TYPES)[keyof typeof NODE_TYPES];
