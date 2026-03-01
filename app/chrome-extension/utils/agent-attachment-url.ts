import { agentFetch } from '@/utils/agent-rpc';

const urlCache = new Map<string, Promise<string | null>>();

function normalizePath(path: string): string {
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

export async function resolveAgentAttachmentUrl(urlPath: string): Promise<string | null> {
  const path = normalizePath(urlPath.trim());
  if (!path || path === '/') {
    return null;
  }

  const cached = urlCache.get(path);
  if (cached) {
    return await cached;
  }

  const pending = (async () => {
    try {
      const response = await agentFetch(path);
      if (!response.ok) {
        return null;
      }
      const blob = await response.blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  })();

  urlCache.set(path, pending);
  return await pending;
}
