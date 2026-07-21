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

import { DEFAULT_TEMP_UPLOAD_MAX_FILE_BYTES } from './file-handler';
import { MAX_TRACE_FILE_BYTES, parseTrace, readTraceJsonFile } from './trace-analyzer';

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
  it('keeps the in-memory parser bound at the production upload limit', () => {
    expect(MAX_TRACE_FILE_BYTES).toBe(DEFAULT_TEMP_UPLOAD_MAX_FILE_BYTES);
  });

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

  it('reads from a caller-owned descriptor without reopening or closing it', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webpage-mcp-trace-fd-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'trace.json');
    await fs.writeFile(filePath, '{"traceEvents":[]}');
    const handle = await fs.open(filePath, 'r');

    try {
      await expect(readTraceJsonFile(handle.fd)).resolves.toEqual({ traceEvents: [] });
      await expect(handle.stat()).resolves.toMatchObject({ size: 18 });
    } finally {
      await handle.close();
    }
  });

  it('does not include invalid trace contents in JSON parse errors', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'webpage-mcp-trace-json-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'trace.json');
    const sensitiveContent = 'do-not-return-this-trace-content';
    await fs.writeFile(filePath, `{"traceEvents":[]} ${sensitiveContent}`);

    const error = await readTraceJsonFile(filePath).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Trace file contains invalid JSON');
    expect((error as Error).message).not.toContain(sensitiveContent);
  });
});
