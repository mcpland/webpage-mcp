import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NOTIFICATIONS, STORAGE_KEYS } from '@/common/constants';
import {
  getFirstConnectNotificationOptions,
  maybeShowFirstConnectNotification,
  resetFirstConnectNotificationStateForTests,
} from '@/entrypoints/background/first-connect-notification';

describe('first native connection notification', () => {
  let storageState: Record<string, unknown>;

  beforeEach(() => {
    vi.useFakeTimers();
    storageState = {};

    (chrome as any).runtime = {
      ...((chrome as any).runtime ?? {}),
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      lastError: null,
    };
    (chrome as any).i18n = {
      getMessage: vi.fn((key: string) => {
        if (key === 'extensionName') {
          return 'Webpage MCP Connector';
        }
        if (key === 'nativeConnectionSuccessNotification') {
          return 'Native host connected. Webpage MCP Connector is ready to use.';
        }
        return '';
      }),
    };
    (chrome as any).notifications = {
      create: vi.fn(
        (
          _id: string,
          _options: chrome.notifications.NotificationOptions,
          callback: (notificationId: string) => void,
        ) => callback('native-first-connect-success'),
      ),
      clear: vi.fn(
        (_id: string, callback: (wasCleared: boolean) => void) => callback(true),
      ),
    };
    (chrome as any).storage = {
      local: {
        get: vi.fn(async (keys?: string | string[]) => {
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, storageState[key]]));
          }
          if (typeof keys === 'string') {
            return { [keys]: storageState[keys] };
          }
          return { ...storageState };
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(storageState, values);
        }),
      },
    };

    resetFirstConnectNotificationStateForTests();
  });

  it('builds the localized notification options', () => {
    expect(getFirstConnectNotificationOptions()).toEqual({
      type: 'basic',
      iconUrl: 'chrome-extension://test/icon/128.png',
      title: 'Webpage MCP Connector',
      message: 'Native host connected. Webpage MCP Connector is ready to use.',
      priority: 2,
    });
  });

  it('shows the notification once and persists the shown flag', async () => {
    await expect(maybeShowFirstConnectNotification()).resolves.toBe(true);

    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [STORAGE_KEYS.NATIVE_FIRST_CONNECT_NOTIFICATION_SHOWN]: true,
    });

    await vi.advanceTimersByTimeAsync(NOTIFICATIONS.AUTO_CLEAR_DELAY_MS);

    expect(chrome.notifications.clear).toHaveBeenCalledWith(
      'native-first-connect-success',
      expect.any(Function),
    );

    await expect(maybeShowFirstConnectNotification()).resolves.toBe(false);
    expect(chrome.notifications.create).toHaveBeenCalledTimes(1);
  });

  it('skips the notification when the shown flag is already stored', async () => {
    storageState[STORAGE_KEYS.NATIVE_FIRST_CONNECT_NOTIFICATION_SHOWN] = true;

    await expect(maybeShowFirstConnectNotification()).resolves.toBe(false);

    expect(chrome.notifications.create).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});
