import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  MAX_TOOL_CALL_TIMEOUT_MS,
  resolveBridgeCallTimeoutMs,
  resolveToolCallTimeoutMs,
} from './tool-timeouts';

describe('resolveToolCallTimeoutMs', () => {
  it('keeps the default for tools without their own wait', () => {
    expect(resolveToolCallTimeoutMs('chrome_read_page', { tabId: 1 })).toBe(
      DEFAULT_TOOL_CALL_TIMEOUT_MS,
    );
    expect(resolveToolCallTimeoutMs('chrome_click_element', { selector: '#a' })).toBe(
      DEFAULT_TOOL_CALL_TIMEOUT_MS,
    );
  });

  it('outlasts the element picker, whose default wait is three minutes', () => {
    expect(resolveToolCallTimeoutMs('chrome_request_element_selection', {})).toBe(195_000);
    expect(
      resolveToolCallTimeoutMs('chrome_request_element_selection', { timeoutMs: 600_000 }),
    ).toBe(615_000);
  });

  it('honours explicit waits of downloads, workflows and timed waits', () => {
    expect(resolveToolCallTimeoutMs('chrome_handle_download', { timeoutMs: 300_000 })).toBe(
      315_000,
    );
    expect(
      resolveToolCallTimeoutMs('chrome_click_element', { waitForDownload: { timeoutMs: 200_000 } }),
    ).toBe(215_000);
    expect(resolveToolCallTimeoutMs('record_replay_flow_run', { timeoutMs: 300_000 })).toBe(
      315_000,
    );
    expect(resolveToolCallTimeoutMs('flow.checkout', { timeoutMs: 400_000 })).toBe(415_000);
    expect(
      resolveToolCallTimeoutMs('chrome_computer', { action: 'wait', text: 'Done', timeout: 120_000 }),
    ).toBe(135_000);
  });

  it('never drops below the default and is capped', () => {
    expect(resolveToolCallTimeoutMs('chrome_javascript', { timeoutMs: 1_000 })).toBe(
      DEFAULT_TOOL_CALL_TIMEOUT_MS,
    );
    expect(resolveToolCallTimeoutMs('record_replay_flow_run', { timeoutMs: 10 ** 9 })).toBe(
      MAX_TOOL_CALL_TIMEOUT_MS,
    );
    expect(resolveToolCallTimeoutMs('chrome_handle_download', { timeoutMs: 'soon' })).toBe(
      DEFAULT_TOOL_CALL_TIMEOUT_MS,
    );
  });

  it('gives the session layer extra time so the inner timeout reports first', () => {
    expect(resolveBridgeCallTimeoutMs('chrome_read_page', {})).toBe(
      DEFAULT_TOOL_CALL_TIMEOUT_MS + 10_000,
    );
  });

  it('ignores Object.prototype property names instead of returning NaN or throwing', () => {
    for (const name of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(resolveToolCallTimeoutMs(name, {})).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS);
      expect(resolveBridgeCallTimeoutMs(name, {})).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS + 10_000);
    }
  });
});
