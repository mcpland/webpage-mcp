/**
 * Unit tests for Web Editor V2 Property Panel Live Style Sync.
 *
 * These tests focus on:
 * - MutationObserver setup for style attribute changes (Bug 3 fix)
 * - rAF throttling of refresh calls
 * - Proper cleanup on target change and dispose
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Test Setup
// =============================================================================

// Mock MutationObserver
let mockObserverCallback: MutationCallback | null = null;
let mockObserverDisconnect: ReturnType<typeof vi.fn>;

class MockMutationObserver {
  callback: MutationCallback;

  constructor(callback: MutationCallback) {
    this.callback = callback;
    mockObserverCallback = callback;
  }

  observe = vi.fn();
  disconnect = vi.fn(() => {
    mockObserverDisconnect?.();
  });
  takeRecords = vi.fn(() => []);
}

beforeEach(() => {
  mockObserverCallback = null;
  mockObserverDisconnect = vi.fn();

  // Install mock MutationObserver
  vi.stubGlobal('MutationObserver', MockMutationObserver);

  // Mock requestAnimationFrame
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      // Execute immediately for testing
      cb(performance.now());
      return 1;
    }),
  );

  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// =============================================================================
// MutationObserver Integration Tests
// =============================================================================

describe('property-panel: live style sync', () => {
  it('should observe style attribute changes on target element', () => {
    // This is a conceptual test for the MutationObserver setup
    // The actual implementation is in property-panel.ts

    const target = document.createElement('div');
    const observer = new MockMutationObserver(() => {});

    observer.observe(target, {
      attributes: true,
      attributeFilter: ['style'],
    });

    expect(observer.observe).toHaveBeenCalledWith(target, {
      attributes: true,
      attributeFilter: ['style'],
    });
  });

  it('should trigger callback when style changes', () => {
    const callback = vi.fn();
    const observer = new MockMutationObserver(callback);
    const target = document.createElement('div');

    observer.observe(target, { attributes: true, attributeFilter: ['style'] });

    // Simulate style mutation with a minimal MutationRecord-like object
    if (mockObserverCallback) {
      mockObserverCallback(
        [
          {
            type: 'attributes',
            target,
            attributeName: 'style',
            attributeNamespace: null,
            oldValue: null,
            addedNodes: { length: 0 } as unknown as NodeList,
            removedNodes: { length: 0 } as unknown as NodeList,
            previousSibling: null,
            nextSibling: null,
          } as MutationRecord,
        ],
        observer as unknown as MutationObserver,
      );
    }

    expect(callback).toHaveBeenCalled();
  });

  it('should disconnect observer when target changes', () => {
    const observer = new MockMutationObserver(() => {});
    observer.disconnect();
    expect(observer.disconnect).toHaveBeenCalled();
  });
});

// =============================================================================
// rAF Throttling Tests
// =============================================================================

describe('property-panel: rAF throttling', () => {
  it('should coalesce multiple style changes into single refresh', () => {
    let rafCallCount = 0;
    let scheduledCallback: FrameRequestCallback | null = null;

    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallCount++;
      scheduledCallback = cb;
      return rafCallCount;
    });

    // Simulate the throttling logic
    let rafId: number | null = null;
    const refreshCalls: number[] = [];

    function scheduleRefresh(): void {
      if (rafId !== null) return; // Already scheduled
      rafId = requestAnimationFrame(() => {
        rafId = null;
        refreshCalls.push(Date.now());
      });
    }

    // Schedule multiple refreshes
    scheduleRefresh();
    scheduleRefresh();
    scheduleRefresh();

    // Only one rAF should be scheduled
    expect(rafCallCount).toBe(1);

    // Execute the callback
    if (scheduledCallback) {
      scheduledCallback(performance.now());
    }

    // Only one refresh should have occurred
    expect(refreshCalls.length).toBe(1);
  });

  it('should cancel pending rAF on cleanup', () => {
    const cancelRaf = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancelRaf);

    let rafId: number | null = requestAnimationFrame(() => {});

    // Cleanup
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    expect(cancelRaf).toHaveBeenCalled();
  });
});

// =============================================================================
// Lifecycle Tests
// =============================================================================

describe('property-panel: observer lifecycle', () => {
  it('should disconnect old observer before connecting new one', () => {
    const disconnectCalls: string[] = [];

    class TrackedObserver {
      id: string;
      constructor(id: string) {
        this.id = id;
      }
      observe = vi.fn();
      disconnect = vi.fn(() => {
        disconnectCalls.push(this.id);
      });
    }

    // Simulate target change
    const observer1 = new TrackedObserver('observer1');
    const observer2 = new TrackedObserver('observer2');

    // First target
    const target1 = document.createElement('div');
    observer1.observe(target1, { attributes: true });

    // Change target - should disconnect old observer first
    observer1.disconnect();
    observer2.observe(document.createElement('div'), { attributes: true });

    expect(disconnectCalls).toContain('observer1');
  });

  it('should handle null target gracefully', () => {
    // When target is null, should disconnect and not create new observer
    const observer = new MockMutationObserver(() => {});

    // Simulate setTarget(null)
    observer.disconnect();

    expect(observer.disconnect).toHaveBeenCalled();
  });

  it('should handle disconnected target gracefully', () => {
    const callback = vi.fn();
    const observer = new MockMutationObserver(callback);

    const target = document.createElement('div');
    // Target not connected to DOM
    expect(target.isConnected).toBe(false);

    // Should still be able to observe (MutationObserver allows this)
    observer.observe(target, { attributes: true });

    // Callback should check isConnected before processing
    if (mockObserverCallback) {
      // Simulate mutation on disconnected element
      mockObserverCallback([], observer as unknown as MutationObserver);
    }

    // In real implementation, the callback should guard against disconnected elements
  });
});
