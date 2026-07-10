import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const engineMocks = vi.hoisted(() => ({
  createWithAllHandlers: vi.fn(),
}));

vi.mock('chrome-devtools-frontend/front_end/models/trace/trace.js', () => ({
  TraceModel: { Model: { createWithAllHandlers: engineMocks.createWithAllHandlers } },
  Types: { Events: { NO_NAVIGATION: 'NO_NAVIGATION' } },
}));
vi.mock(
  'chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceTraceFormatter.js',
  () => ({ PerformanceTraceFormatter: class {} }),
);
vi.mock(
  'chrome-devtools-frontend/front_end/models/ai_assistance/data_formatters/PerformanceInsightFormatter.js',
  () => ({ PerformanceInsightFormatter: class {} }),
);
vi.mock(
  'chrome-devtools-frontend/front_end/models/ai_assistance/performance/AIContext.js',
  () => ({ AgentFocus: { fromParsedTrace: vi.fn() } }),
);

import { parseTrace, readTraceJsonFile } from './trace-analyzer';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  engineMocks.createWithAllHandlers.mockReset();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('trace analyzer resource isolation', () => {
  it('uses an independent trace processor for every concurrent parse', async () => {
    let instance = 0;
    engineMocks.createWithAllHandlers.mockImplementation(() => {
      const id = ++instance;
      return {
        resetProcessor: vi.fn(),
        parse: vi.fn(async () => await Promise.resolve()),
        parsedTrace: vi.fn(() => ({ id, insights: null })),
      };
    });

    const [first, second] = await Promise.all([
      parseTrace([{ name: 'first' }]),
      parseTrace([{ name: 'second' }]),
    ]);

    expect(engineMocks.createWithAllHandlers).toHaveBeenCalledTimes(2);
    expect(first.parsedTrace.id).not.toBe(second.parsedTrace.id);
  });

  it('rejects an oversized trace before JSON parsing', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webpage-mcp-trace-limit-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'trace.json');
    await fs.writeFile(filePath, '{"traceEvents":[]} trailing bytes');

    await expect(readTraceJsonFile(filePath, 8)).rejects.toThrow('exceeds the 8 byte limit');
  });
});
