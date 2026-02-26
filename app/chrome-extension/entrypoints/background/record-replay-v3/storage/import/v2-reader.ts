/**
 * @fileoverview V2 data reader
 * @description Read data in V2 format (placeholder implementation)
 */

/**
 * V2 data reader interface
 * @description Phase 5+ realize
 */
export interface V2Reader {
  /** Read V2 Flows */
  readFlows(): Promise<unknown[]>;
  /** Read V2 Runs */
  readRuns(): Promise<unknown[]>;
  /** Read V2 Triggers */
  readTriggers(): Promise<unknown[]>;
  /** Read V2 Schedules */
  readSchedules(): Promise<unknown[]>;
}

/**
 * Create NotImplemented V2Reader
 */
export function createNotImplementedV2Reader(): V2Reader {
  const notImplemented = async () => {
    throw new Error('V2Reader not implemented');
  };

  return {
    readFlows: notImplemented,
    readRuns: notImplemented,
    readTriggers: notImplemented,
    readSchedules: notImplemented,
  };
}
