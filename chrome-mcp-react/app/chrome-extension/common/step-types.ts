// step-types.ts — re-export shared constants to keep single source of truth
export { STEP_TYPES } from 'webpage-mcp-shared';
export type StepTypeConst =
  (typeof import('webpage-mcp-shared'))['STEP_TYPES'][keyof (typeof import('webpage-mcp-shared'))['STEP_TYPES']];
