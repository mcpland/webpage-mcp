import * as fs from 'node:fs';

// Import DevTools trace engine and formatters from chrome-devtools-frontend
// We intentionally use deep imports to match the package structure.
// These modules are ESM and require NodeNext module resolution.
// Types are loosely typed to minimize coupling with DevTools internals.
import * as TraceEngine from 'chrome-devtools-frontend/front_end/models/trace/trace.js';
import { PerformanceTraceFormatter } from 'chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceTraceFormatter.js';
import { PerformanceInsightFormatter } from 'chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceInsightFormatter.js';
import { AgentFocus } from 'chrome-devtools-frontend/front_end/models/ai_assistance/performance/AIContext.js';

// Trace parsing simultaneously retains the input bytes, decoded text, parsed
// objects, and DevTools' derived model. Match the production per-upload cap
// instead of the aggregate temporary-storage budget.
export const MAX_TRACE_FILE_BYTES = 16 * 1024 * 1024;

export async function readTraceJsonFile(
  filePathOrDescriptor: string | number,
  maximumBytes = MAX_TRACE_FILE_BYTES,
): Promise<any> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError('maximumBytes must be a positive safe integer');
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const stream =
    typeof filePathOrDescriptor === 'number'
      ? fs.createReadStream('', { fd: filePathOrDescriptor, autoClose: false })
      : fs.createReadStream(filePathOrDescriptor);
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maximumBytes) {
      throw new Error(`Trace file exceeds the ${maximumBytes} byte limit`);
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
  } catch {
    // Recent Node.js versions include nearby source text in JSON.parse errors.
    // Keep trace contents out of native messaging error responses.
    throw new Error('Trace file contains invalid JSON');
  }
}

export async function parseTrace(json: any): Promise<{
  parsedTrace: any;
  insights: any | null;
}> {
  const engine = TraceEngine.TraceModel.Model.createWithAllHandlers();
  engine.resetProcessor();
  const events = Array.isArray(json) ? json : json.traceEvents;
  if (!events || !Array.isArray(events)) {
    throw new Error('Invalid trace format: expected array or {traceEvents: []}');
  }
  await engine.parse(events);
  const parsedTrace = engine.parsedTrace();
  const insights = parsedTrace?.insights ?? null;
  if (!parsedTrace) throw new Error('No parsed trace returned by engine');
  return { parsedTrace, insights };
}

export function getTraceSummary(parsedTrace: any): string {
  const focus = AgentFocus.fromParsedTrace(parsedTrace);
  const formatter = new PerformanceTraceFormatter(focus);
  return formatter.formatTraceSummary();
}

export function getInsightText(parsedTrace: any, insights: any, insightName: string): string {
  if (!insights) throw new Error('No insights available for this trace');
  const mainNavId = parsedTrace.data?.Meta?.mainFrameNavigations?.at(0)?.args?.data?.navigationId;
  const NO_NAV = TraceEngine.Types.Events.NO_NAVIGATION;
  const set = insights.get(mainNavId ?? NO_NAV);
  if (!set) throw new Error('No insights for selected navigation');
  const model = set.model || {};
  if (!(insightName in model)) throw new Error(`Insight not found: ${insightName}`);
  const formatter = new PerformanceInsightFormatter(
    AgentFocus.fromParsedTrace(parsedTrace),
    model[insightName],
  );
  return formatter.formatInsight();
}

export async function analyzeTraceFile(
  filePathOrDescriptor: string | number,
  insightName?: string,
): Promise<{
  summary: string;
  insight?: string;
}> {
  const json = await readTraceJsonFile(filePathOrDescriptor);
  const { parsedTrace, insights } = await parseTrace(json);
  const summary = getTraceSummary(parsedTrace);
  if (insightName) {
    try {
      const insight = getInsightText(parsedTrace, insights, insightName);
      return { summary, insight };
    } catch {
      // If requested insight missing, still return summary
      return { summary };
    }
  }
  return { summary };
}

export default { analyzeTraceFile };
