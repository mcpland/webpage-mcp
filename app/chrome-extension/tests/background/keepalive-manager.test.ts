import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createOffscreenKeepaliveController: vi.fn(),
}));

vi.mock('@/entrypoints/background/record-replay-v3/engine/keepalive/offscreen-keepalive', () => {
  class FakeInMemoryKeepaliveController {
    private refs = new Map<string, number>();

    acquire(tag: string): () => void {
      const count = this.refs.get(tag) ?? 0;
      this.refs.set(tag, count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = (this.refs.get(tag) ?? 1) - 1;
        if (next <= 0) this.refs.delete(tag);
        else this.refs.set(tag, next);
      };
    }

    isActive(): boolean {
      return this.refs.size > 0;
    }

    getRefCount(): number {
      let total = 0;
      for (const count of this.refs.values()) total += count;
      return total;
    }

    releaseAll(): void {
      this.refs.clear();
    }
  }

  return {
    createOffscreenKeepaliveController: mocks.createOffscreenKeepaliveController,
    InMemoryKeepaliveController: FakeInMemoryKeepaliveController,
  };
});

function stubChrome(partial: Record<string, unknown>) {
  vi.stubGlobal('chrome', partial);
}

describe('keepalive-manager', () => {
  beforeEach(() => {
    mocks.createOffscreenKeepaliveController.mockReset();
    mocks.createOffscreenKeepaliveController.mockReturnValue({
      acquire: vi.fn(() => () => undefined),
      isActive: vi.fn(() => true),
      getRefCount: vi.fn(() => 1),
      releaseAll: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('uses a passive controller outside MV3 runtimes', async () => {
    stubChrome({
      runtime: {
        getManifest: () => ({ manifest_version: 2 }),
      },
    });

    const { acquireKeepalive, getKeepaliveRefCount, isKeepaliveActive } = await import(
      '@/entrypoints/background/keepalive-manager'
    );

    const release = acquireKeepalive('mv2');
    expect(mocks.createOffscreenKeepaliveController).not.toHaveBeenCalled();
    expect(getKeepaliveRefCount()).toBe(1);
    expect(isKeepaliveActive()).toBe(true);

    release();
    expect(getKeepaliveRefCount()).toBe(0);
    expect(isKeepaliveActive()).toBe(false);
  });

  it('uses a passive controller when MV3 offscreen APIs are unavailable', async () => {
    stubChrome({
      runtime: {
        getManifest: () => ({ manifest_version: 3 }),
      },
    });

    const { acquireKeepalive, getKeepaliveRefCount } = await import(
      '@/entrypoints/background/keepalive-manager'
    );

    const release = acquireKeepalive('mv3-no-offscreen');
    expect(mocks.createOffscreenKeepaliveController).not.toHaveBeenCalled();
    expect(getKeepaliveRefCount()).toBe(1);

    release();
    expect(getKeepaliveRefCount()).toBe(0);
  });

  it('uses the offscreen controller when MV3 capabilities are available', async () => {
    const acquire = vi.fn(() => () => undefined);
    mocks.createOffscreenKeepaliveController.mockReturnValue({
      acquire,
      isActive: vi.fn(() => true),
      getRefCount: vi.fn(() => 1),
      releaseAll: vi.fn(),
    });

    stubChrome({
      offscreen: { createDocument: vi.fn() },
      runtime: {
        getManifest: () => ({ manifest_version: 3 }),
        onConnect: { addListener: vi.fn() },
      },
    });

    const { acquireKeepalive } = await import('@/entrypoints/background/keepalive-manager');

    acquireKeepalive('mv3-offscreen');
    expect(mocks.createOffscreenKeepaliveController).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith('mv3-offscreen');
  });
});
