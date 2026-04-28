import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
  locateElement: vi.fn(),
  appendRun: vi.fn(),
  waitForNavigationDone: vi.fn(),
  maybeQuickWaitForNav: vi.fn(),
  ensureReadPageIfWeb: vi.fn(),
  waitForNetworkIdle: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: mocks.handleCallTool,
}));

vi.mock('@/entrypoints/background/record-replay/selector-engine', () => ({
  locateElement: mocks.locateElement,
}));

vi.mock('@/entrypoints/background/record-replay/flow-store', () => ({
  appendRun: mocks.appendRun,
  getFlow: vi.fn(),
}));

vi.mock('@/entrypoints/background/record-replay/engine/policies/wait', () => ({
  waitForNavigationDone: mocks.waitForNavigationDone,
  maybeQuickWaitForNav: mocks.maybeQuickWaitForNav,
  ensureReadPageIfWeb: mocks.ensureReadPageIfWeb,
  waitForNetworkIdle: mocks.waitForNetworkIdle,
}));

import { runFlow } from '@/entrypoints/background/record-replay/flow-runner';
import type { Flow, RunLogEntry, RunResult } from '@/entrypoints/background/record-replay/types';
import { TOOL_NAMES } from 'webpage-mcp-shared';

type TabMode = 'foreground' | 'background';
type TabTargetMode = 'currentTab' | 'newTab';

interface BenchmarkScenario {
  id: string;
  tabTarget: TabTargetMode;
  tabMode: TabMode;
  initialTabId: number;
}

interface BenchmarkAttempt {
  scenarioId: string;
  iteration: number;
  success: boolean;
  failureType: string | null;
  failedStepId: string | null;
  screenshotBase64: string | null;
  domSnapshot: string | null;
  retryBefore: RunLogEntry | null;
  retryAfter: RunLogEntry | null;
  result: RunResult;
}

interface BenchmarkSummary {
  attempts: BenchmarkAttempt[];
  totalRuns: number;
  failedRuns: number;
  flakeRate: number;
  retryRecoveredRuns: number;
}

interface TestTab {
  id: number;
  url: string;
  title: string;
  active: boolean;
  currentWindow: boolean;
  windowId: number;
  status: 'loading' | 'complete';
}

const FIXTURE_PAGES = {
  form: {
    url: 'https://fixtures.local/replay/form.html',
    html: [
      '<main data-fixture="workflow-replay">',
      '<input id="name" value="">',
      '<button id="submit">Submit</button>',
      '<output id="status">Ready</output>',
      '<div id="result">Ada Lovelace</div>',
      '</main>',
    ].join(''),
    screenshot: 'fixture-form-screenshot-base64',
  },
};

const BENCHMARK_SCENARIOS: BenchmarkScenario[] = [
  { id: 'foreground-currentTab', tabTarget: 'currentTab', tabMode: 'foreground', initialTabId: 11 },
  { id: 'background-currentTab', tabTarget: 'currentTab', tabMode: 'background', initialTabId: 12 },
  { id: 'foreground-newTab', tabTarget: 'newTab', tabMode: 'foreground', initialTabId: 13 },
  { id: 'background-newTab', tabTarget: 'newTab', tabMode: 'background', initialTabId: 14 },
];

const ITERATIONS_PER_SCENARIO = 3;

const SAMPLE_WORKFLOW: Flow = {
  id: 'replay-stability-fixture',
  name: 'Replay Stability Fixture',
  version: 1,
  variables: [],
  nodes: [
    {
      id: 'fill-name',
      type: 'fill',
      config: {
        target: { candidates: [{ type: 'css', value: '#name' }] },
        value: 'Ada Lovelace',
      },
    },
    {
      id: 'click-submit',
      type: 'click',
      config: {
        target: { candidates: [{ type: 'css', value: '#submit' }] },
        retry: { count: 1, intervalMs: 0, backoff: 'none' },
      },
    },
    {
      id: 'wait-ready',
      type: 'wait',
      config: { condition: { text: 'Ready', appear: true }, timeoutMs: 1000 },
    },
    {
      id: 'extract-result',
      type: 'extract',
      config: { selector: '#result', attr: 'text', saveAs: 'resultText' },
    },
    {
      id: 'screenshot-result',
      type: 'screenshot',
      config: { saveAs: 'resultScreenshot' },
    },
  ],
  edges: [
    { id: 'e1', from: 'fill-name', to: 'click-submit' },
    { id: 'e2', from: 'click-submit', to: 'wait-ready' },
    { id: 'e3', from: 'wait-ready', to: 'extract-result' },
    { id: 'e4', from: 'extract-result', to: 'screenshot-result' },
  ],
};

function createInitialTabs(activeTabId: number): TestTab[] {
  return [
    {
      id: activeTabId,
      url: FIXTURE_PAGES.form.url,
      title: 'Replay Fixture',
      active: true,
      currentWindow: true,
      windowId: 1,
      status: 'complete',
    },
    {
      id: 999,
      url: 'https://fixtures.local/decoy.html',
      title: 'Decoy Tab',
      active: false,
      currentWindow: true,
      windowId: 1,
      status: 'complete',
    },
  ];
}

function setupChromeHarness(activeTabId: number) {
  const tabs = createInitialTabs(activeTabId);
  let nextTabId = 200;

  const findTab = (tabId: number) => tabs.find((tab) => tab.id === tabId);

  const activate = (tabId: number) => {
    for (const tab of tabs) {
      if (tab.currentWindow) tab.active = tab.id === tabId;
    }
  };

  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension-id',
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      query: vi.fn(async (queryInfo?: chrome.tabs.QueryInfo) => {
        let result = tabs.slice();
        if (queryInfo?.currentWindow) {
          result = result.filter((tab) => tab.currentWindow);
        }
        if (queryInfo?.active) {
          result = result.filter((tab) => tab.active);
        }
        return result.map((tab) => ({ ...tab }));
      }),
      get: vi.fn(async (tabId: number) => {
        const tab = findTab(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return { ...tab };
      }),
      create: vi.fn(async (createProperties: chrome.tabs.CreateProperties) => {
        const tab: TestTab = {
          id: nextTabId++,
          url: String(createProperties.url || 'about:blank'),
          title: 'Replay Fixture',
          active: createProperties.active !== false,
          currentWindow: true,
          windowId: 1,
          status: 'complete',
        };
        tabs.push(tab);
        if (tab.active) activate(tab.id);
        return { ...tab };
      }),
      update: vi.fn(async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => {
        const tab = findTab(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        if (typeof updateProperties.url === 'string') tab.url = updateProperties.url;
        if (updateProperties.active === true) activate(tabId);
        return { ...tab };
      }),
      sendMessage: vi.fn(async (_tabId: number, message: Record<string, unknown>) => {
        if (message.action === 'resolveRef') {
          return {
            success: true,
            rect: { width: 120, height: 32 },
            selector: '#submit',
          };
        }
        if (message.action === 'waitForText' || message.action === 'waitForSelector') {
          return { success: true };
        }
        return { success: true };
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async (details: any) => {
        if (Array.isArray(details.files)) {
          return [{ result: true }];
        }
        const args = details.args || [];
        if (args[0] === '#result') {
          return [{ result: 'Ada Lovelace' }];
        }
        return [{ result: true }];
      }),
    },
    webNavigation: {
      getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, url: FIXTURE_PAGES.form.url }]),
      onCommitted: { addListener: vi.fn(), removeListener: vi.fn() },
      onCompleted: { addListener: vi.fn(), removeListener: vi.fn() },
      onHistoryStateUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });

  return { tabs };
}

function extractFailureType(result: RunResult): string | null {
  const failed = result.logs?.find((log) => log.status === 'failed');
  if (!failed) return null;
  if (failed.message?.includes('selector')) return 'selector';
  if (failed.message?.includes('timeout')) return 'timeout';
  if (failed.message?.includes('tab')) return 'tab';
  return 'runtime';
}

function firstFailedStepId(result: RunResult): string | null {
  return result.logs?.find((log) => log.status === 'failed')?.stepId ?? null;
}

function retryBeforeAfter(logs: RunLogEntry[] | undefined): {
  retryBefore: RunLogEntry | null;
  retryAfter: RunLogEntry | null;
} {
  const retryIndex = logs?.findIndex((log) => log.status === 'retrying') ?? -1;
  if (!logs || retryIndex < 0) {
    return { retryBefore: null, retryAfter: null };
  }
  const retryLog = logs[retryIndex];
  const recovered = logs
    .slice(retryIndex + 1)
    .find((log) => log.stepId === retryLog.stepId && log.status === 'success');
  return {
    retryBefore: retryLog,
    retryAfter: recovered ?? null,
  };
}

function formatBenchmarkFailureEvidence(summary: BenchmarkSummary): string {
  return JSON.stringify(
    {
      totalRuns: summary.totalRuns,
      failedRuns: summary.failedRuns,
      flakeRate: summary.flakeRate,
      retryRecoveredRuns: summary.retryRecoveredRuns,
      failures: summary.attempts
        .filter((attempt) => !attempt.success)
        .map((attempt) => ({
          scenarioId: attempt.scenarioId,
          iteration: attempt.iteration,
          failureType: attempt.failureType,
          failedStepId: attempt.failedStepId,
          screenshotBase64: attempt.screenshotBase64,
          domSnapshot: attempt.domSnapshot,
          retryBefore: attempt.retryBefore,
          retryAfter: attempt.retryAfter,
          logs: attempt.result.logs,
        })),
    },
    null,
    2,
  );
}

async function runBenchmarkAttempt(
  scenario: BenchmarkScenario,
  iteration: number,
): Promise<BenchmarkAttempt> {
  setupChromeHarness(scenario.initialTabId);
  const domSnapshots: string[] = [];
  const clickAttemptsByIteration = new Map<number, number>();

  mocks.locateElement.mockResolvedValue({ ref: 'ref_fixture', frameId: 0, resolvedBy: 'css' });
  mocks.handleCallTool.mockImplementation(async ({ name, args }) => {
    if (name === TOOL_NAMES.BROWSER.READ_PAGE) {
      domSnapshots.push(FIXTURE_PAGES.form.html);
      return { content: [{ type: 'text', text: FIXTURE_PAGES.form.html }] };
    }
    if (name === TOOL_NAMES.BROWSER.CLICK) {
      const attempts = clickAttemptsByIteration.get(iteration) ?? 0;
      clickAttemptsByIteration.set(iteration, attempts + 1);
      if (iteration === 0 && attempts === 0) {
        return { isError: true, content: [{ type: 'text', text: 'controlled click retry' }] };
      }
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    }
    if (name === TOOL_NAMES.BROWSER.FILL || name === TOOL_NAMES.BROWSER.KEYBOARD) {
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    }
    if (name === TOOL_NAMES.BROWSER.SCREENSHOT) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ base64Data: FIXTURE_PAGES.form.screenshot }),
          },
        ],
      };
    }
    if (name === TOOL_NAMES.BROWSER.COMPUTER && args?.action === 'screenshot') {
      return { content: [{ type: 'image', data: FIXTURE_PAGES.form.screenshot }] };
    }
    if (name === TOOL_NAMES.BROWSER.NAVIGATE) {
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    }
    return { content: [{ type: 'text', text: '{"ok":true}' }] };
  });

  const result = await runFlow(SAMPLE_WORKFLOW, {
    tabTarget: scenario.tabTarget === 'newTab' ? 'new' : 'current',
    tabId: scenario.tabTarget === 'currentTab' ? scenario.initialTabId : undefined,
    execution: { backgroundTabs: scenario.tabMode === 'background' },
    returnLogs: true,
    debugStepByStep: true,
    captureStepScreenshots: true,
    timeoutMs: 10_000,
  });

  const retry = retryBeforeAfter(result.logs);

  return {
    scenarioId: scenario.id,
    iteration,
    success: result.success,
    failureType: extractFailureType(result),
    failedStepId: firstFailedStepId(result),
    screenshotBase64:
      result.screenshots?.onFailure ??
      result.debug?.steps.find((step) => !!step.screenshotBase64)?.screenshotBase64 ??
      null,
    domSnapshot: domSnapshots.at(-1) ?? null,
    retryBefore: retry.retryBefore,
    retryAfter: retry.retryAfter,
    result,
  };
}

async function runReplayStabilityBenchmark(): Promise<BenchmarkSummary> {
  const attempts: BenchmarkAttempt[] = [];
  for (const scenario of BENCHMARK_SCENARIOS) {
    for (let iteration = 0; iteration < ITERATIONS_PER_SCENARIO; iteration++) {
      attempts.push(await runBenchmarkAttempt(scenario, iteration));
    }
  }
  const failedRuns = attempts.filter((attempt) => !attempt.success).length;
  const retryRecoveredRuns = attempts.filter(
    (attempt) => attempt.retryBefore && attempt.retryAfter && attempt.success,
  ).length;
  return {
    attempts,
    totalRuns: attempts.length,
    failedRuns,
    flakeRate: failedRuns / attempts.length,
    retryRecoveredRuns,
  };
}

describe('workflow replay stability benchmark baseline', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.waitForNavigationDone.mockResolvedValue(undefined);
    mocks.maybeQuickWaitForNav.mockResolvedValue(undefined);
    mocks.ensureReadPageIfWeb.mockResolvedValue(undefined);
    mocks.waitForNetworkIdle.mockResolvedValue(undefined);
    mocks.appendRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('measures foreground/background and current/new tab replay flake rate with artifacts', async () => {
    const summary = await runReplayStabilityBenchmark();

    if (summary.failedRuns > 0) {
      throw new Error(
        `Workflow replay stability benchmark failed:\n${formatBenchmarkFailureEvidence(summary)}`,
      );
    }

    expect(summary.totalRuns).toBe(BENCHMARK_SCENARIOS.length * ITERATIONS_PER_SCENARIO);
    expect(summary.failedRuns).toBe(0);
    expect(summary.flakeRate).toBe(0);
    expect(summary.retryRecoveredRuns).toBe(BENCHMARK_SCENARIOS.length);

    for (const scenario of BENCHMARK_SCENARIOS) {
      const attempts = summary.attempts.filter((attempt) => attempt.scenarioId === scenario.id);
      expect(attempts).toHaveLength(ITERATIONS_PER_SCENARIO);
      for (const attempt of attempts) {
        expect(attempt.failureType).toBeNull();
        expect(attempt.failedStepId).toBeNull();
        expect(attempt.domSnapshot).toContain('data-fixture="workflow-replay"');
        expect(attempt.screenshotBase64).toBe(FIXTURE_PAGES.form.screenshot);
        expect(attempt.result.outputs?.resultText).toBe('Ada Lovelace');
      }
    }
  });
});
