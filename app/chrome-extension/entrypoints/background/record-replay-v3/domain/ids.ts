/**
 * @fileoverview ID type definition
 * @description Define the various ID types used in Record-Replay V3
 */

/** Flow unique identifier */
export type FlowId = string;

/** Node unique identifier */
export type NodeId = string;

/** Edge unique identifier */
export type EdgeId = string;

/** Run unique identifier */
export type RunId = string;

/** Trigger unique identifier */
export type TriggerId = string;

/** Edge Tag type */
export type EdgeLabel = string;

/** Predefined Edge label constants */
export const EDGE_LABELS = {
  /** Default edge */
  DEFAULT: 'default',
  /** error handling edge */
  ON_ERROR: 'onError',
  /** The edge when the condition is true */
  TRUE: 'true',
  /** edge when condition is false */
  FALSE: 'false',
} as const;

/** Edge Label type (deduced from constant) */
export type EdgeLabelValue = (typeof EDGE_LABELS)[keyof typeof EDGE_LABELS];
