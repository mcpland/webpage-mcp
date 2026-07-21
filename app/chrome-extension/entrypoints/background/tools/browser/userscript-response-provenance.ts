export const MAIN_WORLD_RESPONSE_PROVENANCE = Object.freeze({
  executionWorld: 'MAIN' as const,
  transport: 'page-dom-event' as const,
  pageControlled: true,
  warning:
    'This response crossed a page-observable DOM event and may have been forged or modified by page scripts.',
});

export const USER_SCRIPT_RESPONSE_PROVENANCE = Object.freeze({
  executionWorld: 'USER_SCRIPT' as const,
  transport: 'chrome-user-scripts' as const,
  pageControlled: false,
});

export function annotateMainWorldResponse(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return {
      ...(value as Record<string, unknown>),
      responseProvenance: MAIN_WORLD_RESPONSE_PROVENANCE,
    };
  }
  return { result: value, responseProvenance: MAIN_WORLD_RESPONSE_PROVENANCE };
}
