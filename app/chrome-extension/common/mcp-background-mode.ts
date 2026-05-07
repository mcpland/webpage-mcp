export const MCP_BACKGROUND_MODE_STORAGE_KEY = 'mcpBackgroundModeEnabled';

function getLocalStorage() {
  if (typeof chrome === 'undefined') {
    return undefined;
  }
  return chrome.storage?.local;
}

export async function readMcpBackgroundModeDefault(): Promise<boolean> {
  const storage = getLocalStorage();
  if (!storage?.get) {
    return false;
  }

  try {
    const stored = await storage.get([MCP_BACKGROUND_MODE_STORAGE_KEY]);
    return stored?.[MCP_BACKGROUND_MODE_STORAGE_KEY] === true;
  } catch {
    return false;
  }
}

export async function writeMcpBackgroundModeDefault(
  enabled: boolean,
): Promise<void> {
  const storage = getLocalStorage();
  if (!storage?.set) {
    throw new Error('chrome.storage.local is unavailable');
  }

  await storage.set({ [MCP_BACKGROUND_MODE_STORAGE_KEY]: enabled === true });
}
