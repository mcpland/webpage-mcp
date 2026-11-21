/**
 * Timeouts for forwarding one MCP tool call to the extension.
 *
 * Several tools wait on purpose (for the user to pick elements, for a download,
 * for a workflow or a timed capture) and accept their own timeout argument.
 * A single fixed 120s bridge limit cut those calls off mid-wait even when the
 * caller had asked for longer, so the limit is derived from the arguments.
 */

export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120_000;
export const MAX_TOOL_CALL_TIMEOUT_MS = 15 * 60_000;
/** Headroom on top of a tool's own wait for setup and result transfer. */
const TOOL_WAIT_MARGIN_MS = 15_000;
/** The outer (MCP session) timeout fires after the inner one so the inner error wins. */
const SESSION_TIMEOUT_MARGIN_MS = 10_000;
const DEFAULT_CLICK_DOWNLOAD_WAIT_MS = 30_000;

type ToolArgs = Record<string, unknown>;
type WaitEstimator = (args: ToolArgs) => number | undefined;

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function downloadWaitMs(value: unknown): number | undefined {
  if (value === true) return DEFAULT_CLICK_DOWNLOAD_WAIT_MS;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return positiveNumber((value as ToolArgs).timeoutMs) ?? DEFAULT_CLICK_DOWNLOAD_WAIT_MS;
  }
  return undefined;
}

const TOOL_WAITS: Record<string, WaitEstimator> = {
  // Defaults mirror the extension's own defaults for these waits.
  chrome_request_element_selection: (args) => positiveNumber(args.timeoutMs) ?? 180_000,
  chrome_handle_download: (args) => positiveNumber(args.timeoutMs) ?? 60_000,
  chrome_click_element: (args) => downloadWaitMs(args.waitForDownload),
  chrome_computer: (args) => {
    if (args.action === 'wait') {
      return typeof args.text === 'string' && args.text.trim()
        ? (positiveNumber(args.timeout) ?? 10_000)
        : (positiveNumber(args.duration) ?? 0) * 1000;
    }
    return downloadWaitMs(args.waitForDownload);
  },
  chrome_javascript: (args) => positiveNumber(args.timeoutMs),
  chrome_console: (args) => positiveNumber(args.waitMs),
  chrome_network_capture: (args) => positiveNumber(args.durationMs),
  chrome_gif_recorder: (args) => positiveNumber(args.durationMs),
  performance_start_trace: (args) =>
    args.autoStop === true ? (positiveNumber(args.durationMs) ?? 5_000) : undefined,
  performance_analyze_insight: (args) => positiveNumber(args.timeoutMs),
  record_replay_flow_run: (args) => positiveNumber(args.timeoutMs),
  record_replay_run_cancel: (args) =>
    args.waitForTerminal === false ? undefined : positiveNumber(args.timeoutMs),
  workflow_run: (args) => positiveNumber(args.timeoutMs),
  // Each stabilization iteration replays the whole workflow.
  workflow_stabilize: (args) => (positiveNumber(args.iterations) ?? 3) * 60_000,
};

/** Timeout for the native host -> extension request of one tool call. */
export function resolveToolCallTimeoutMs(name: string, args: unknown): number {
  const record =
    args && typeof args === 'object' && !Array.isArray(args) ? (args as ToolArgs) : {};
  const estimator =
    TOOL_WAITS[name] ?? (name.startsWith('flow.') ? TOOL_WAITS.workflow_run : undefined);
  const wait = estimator?.(record);
  if (!wait) return DEFAULT_TOOL_CALL_TIMEOUT_MS;
  return Math.min(
    MAX_TOOL_CALL_TIMEOUT_MS,
    Math.max(DEFAULT_TOOL_CALL_TIMEOUT_MS, Math.ceil(wait) + TOOL_WAIT_MARGIN_MS),
  );
}

/** Timeout for the MCP session -> native host IPC request of one tool call. */
export function resolveBridgeCallTimeoutMs(name: string, args: unknown): number {
  return resolveToolCallTimeoutMs(name, args) + SESSION_TIMEOUT_MARGIN_MS;
}
