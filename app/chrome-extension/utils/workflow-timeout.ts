export function workflowTimeoutMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1_000, Math.floor(value)) : 60_000;
}
