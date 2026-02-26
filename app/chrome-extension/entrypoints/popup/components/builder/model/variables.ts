// variables.ts — Shared variable suggestion types for builder UI
export type VariableOrigin = 'global' | 'node';

export interface VariableOption {
  key: string;
  origin: VariableOrigin;
  nodeId?: string;
  nodeName?: string;
}

export const VAR_TOKEN_OPEN = '{';
export const VAR_TOKEN_CLOSE = '}';
export const VAR_PLACEHOLDER = '{}';
