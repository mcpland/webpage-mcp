import { NOTIFICATIONS, STORAGE_KEYS } from '@/common/constants';

const FIRST_CONNECT_NOTIFICATION_ID = 'native-first-connect-success';

let firstConnectNotificationShown: boolean | null = null;
let firstConnectNotificationInFlight: Promise<boolean> | null = null;

function getLocalizedMessage(key: string, fallback: string): string {
  try {
    const localized = chrome.i18n?.getMessage?.(key);
    return localized || fallback;
  } catch {
    return fallback;
  }
}

function createNotification(
  options: chrome.notifications.NotificationOptions<true>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!chrome.notifications?.create) {
      reject(new Error('chrome.notifications.create is unavailable'));
      return;
    }

    chrome.notifications.create(
      FIRST_CONNECT_NOTIFICATION_ID,
      options,
      (notificationId) => {
        const error = chrome.runtime.lastError;
        if (error?.message) {
          reject(new Error(error.message));
          return;
        }
        resolve(notificationId);
      },
    );
  });
}

function clearNotification(notificationId: string): Promise<void> {
  return new Promise((resolve) => {
    if (!chrome.notifications?.clear) {
      resolve();
      return;
    }

    chrome.notifications.clear(notificationId, () => {
      resolve();
    });
  });
}

async function hasShownFirstConnectNotification(): Promise<boolean> {
  if (firstConnectNotificationShown !== null) {
    return firstConnectNotificationShown;
  }

  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.NATIVE_FIRST_CONNECT_NOTIFICATION_SHOWN,
    ]);
    firstConnectNotificationShown =
      result[STORAGE_KEYS.NATIVE_FIRST_CONNECT_NOTIFICATION_SHOWN] === true;
  } catch {
    firstConnectNotificationShown = false;
  }

  return firstConnectNotificationShown;
}

async function markFirstConnectNotificationShown(): Promise<void> {
  firstConnectNotificationShown = true;
  await chrome.storage.local.set({
    [STORAGE_KEYS.NATIVE_FIRST_CONNECT_NOTIFICATION_SHOWN]: true,
  });
}

export function getFirstConnectNotificationOptions(): chrome.notifications.NotificationOptions<true> {
  return {
    type: NOTIFICATIONS.TYPE,
    iconUrl: chrome.runtime.getURL('icon/128.png'),
    title: getLocalizedMessage('extensionName', 'Webpage MCP Connector'),
    message: getLocalizedMessage(
      'nativeConnectionSuccessNotification',
      'Native host connected. Webpage MCP Connector is ready to use.',
    ),
    priority: NOTIFICATIONS.PRIORITY,
  };
}

export async function maybeShowFirstConnectNotification(): Promise<boolean> {
  if (firstConnectNotificationInFlight) {
    return firstConnectNotificationInFlight;
  }

  firstConnectNotificationInFlight = (async () => {
    if (!chrome.notifications?.create) {
      return false;
    }

    if (await hasShownFirstConnectNotification()) {
      return false;
    }

    const notificationId = await createNotification(
      getFirstConnectNotificationOptions(),
    );
    await markFirstConnectNotificationShown();

    setTimeout(() => {
      void clearNotification(notificationId).catch(() => {
        // Ignore notification clear failures.
      });
    }, NOTIFICATIONS.AUTO_CLEAR_DELAY_MS);

    return true;
  })()
    .catch((error) => {
      console.warn(
        '[FirstConnectNotification] Failed to show first-connect notification',
        error,
      );
      return false;
    })
    .finally(() => {
      firstConnectNotificationInFlight = null;
    });

  return firstConnectNotificationInFlight;
}

export function resetFirstConnectNotificationStateForTests(): void {
  firstConnectNotificationShown = null;
  firstConnectNotificationInFlight = null;
}
