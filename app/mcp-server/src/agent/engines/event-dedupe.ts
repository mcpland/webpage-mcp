import { createHash } from 'node:crypto';

/**
 * Create a stable, collision-resistant key for streamed agent events.
 */
export function createAgentEventDedupKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
