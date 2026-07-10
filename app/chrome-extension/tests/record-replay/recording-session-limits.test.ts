import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKGROUND_MESSAGE_TYPES, TOOL_MESSAGE_TYPES } from '@/common/message-types';
import {
  RecordingSessionManager,
  type RecordingSessionLimits,
} from '@/entrypoints/background/record-replay/recording/session-manager';
import type { Flow, Step, VariableDef } from '@/entrypoints/background/record-replay/types';

function flow(): Flow {
  const now = new Date().toISOString();
  return {
    id: 'bounded-recording',
    name: 'Bounded recording',
    version: 1,
    nodes: [],
    edges: [],
    variables: [],
    meta: { createdAt: now, updatedAt: now },
  };
}

function step(id: string, value?: string): Step {
  return {
    id,
    type: value === undefined ? 'click' : 'fill',
    ...(value === undefined ? {} : { value }),
  } as Step;
}

function manager(limits: Partial<RecordingSessionLimits>): RecordingSessionManager {
  return new RecordingSessionManager(limits);
}

describe('recording session aggregate limits', () => {
  beforeEach(() => {
    (chrome.tabs as any).sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.mocked(chrome.runtime.sendMessage).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops at the node limit and records explicit truncation metadata', async () => {
    const recording = manager({ maxNodes: 2 });
    const currentFlow = flow();
    await recording.startSession(currentFlow, 7);

    const result = recording.appendSteps([step('one'), step('two'), step('three')]);

    expect(result).toEqual({ accepted: 2, truncated: true, reason: 'node_count' });
    expect(currentFlow.nodes).toHaveLength(2);
    expect(currentFlow.meta?.recording).toMatchObject({
      truncated: true,
      truncationReason: 'node_count',
      truncationLimit: 2,
    });
    expect(recording.canAcceptSteps()).toBe(false);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: BACKGROUND_MESSAGE_TYPES.RR_STOP_RECORDING }),
    );
  });

  it('uses the installed manager callback for a single automatic stop', async () => {
    const recording = manager({ maxNodes: 1 });
    const stopHandler = vi.fn();
    recording.setLimitHandler(stopHandler);
    await recording.startSession(flow(), 7);

    recording.appendSteps([step('one'), step('two')]);
    recording.appendSteps([step('three')]);
    await Promise.resolve();

    expect(stopHandler).toHaveBeenCalledTimes(1);
    expect(stopHandler).toHaveBeenCalledWith('node_count');
  });

  it('enforces aggregate UTF-8 payload bytes across node upserts', async () => {
    const recording = manager({ maxPayloadBytes: 300 });
    await recording.startSession(flow(), 7);
    expect(recording.appendSteps([step('field', 'small')]).truncated).toBe(false);

    const result = recording.appendSteps([step('field', '界'.repeat(200))]);

    expect(result).toMatchObject({ accepted: 0, truncated: true, reason: 'payload_bytes' });
    expect((recording.getFlow()?.nodes?.[0].config as any)?.value).toBe('small');
    expect(recording.getBudgetState().payloadBytes).toBeLessThanOrEqual(300);
  });

  it('bounds variable count and variable payload bytes', async () => {
    const recording = manager({ maxVariables: 1, maxPayloadBytes: 1_024 });
    await recording.startSession(flow(), 7);
    const variables: VariableDef[] = [
      { key: 'first', default: 'one' },
      { key: 'second', default: 'two' },
    ];

    expect(recording.appendVariables(variables)).toEqual({
      accepted: 1,
      truncated: true,
      reason: 'variable_count',
    });
    expect(recording.getFlow()?.variables).toEqual([{ key: 'first', default: 'one' }]);
  });

  it('enforces duration and per-second event-rate limits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const durationBound = manager({ maxDurationMs: 1_000 });
    await durationBound.startSession(flow(), 7);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(durationBound.getBudgetState().limitReached).toBe('duration');
    expect(durationBound.appendSteps([step('late')])).toMatchObject({
      truncated: true,
      reason: 'duration',
    });

    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
    const rateBound = manager({ maxStepsPerSecond: 2 });
    await rateBound.startSession(flow(), 7);
    expect(rateBound.appendSteps([step('one'), step('two')]).truncated).toBe(false);
    expect(rateBound.appendSteps([step('three')])).toMatchObject({
      accepted: 0,
      truncated: true,
      reason: 'step_rate',
    });
  });

  it('broadcasts only a fixed recent timeline window with the total count', async () => {
    const recording = manager({ timelineWindow: 2 });
    await recording.startSession(flow(), 7);
    recording.appendSteps([step('one'), step('two'), step('three')]);

    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({
        action: TOOL_MESSAGE_TYPES.RR_TIMELINE_UPDATE,
        steps: [expect.objectContaining({ id: 'two' }), expect.objectContaining({ id: 'three' })],
        totalSteps: 3,
      }),
      { frameId: 0 },
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TOOL_MESSAGE_TYPES.RR_TIMELINE_UPDATE,
        totalSteps: 3,
        steps: expect.arrayContaining([expect.objectContaining({ id: 'three' })]),
      }),
    );
  });
});
