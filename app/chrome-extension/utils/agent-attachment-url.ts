import { requestAgentRpcBlob } from '@/utils/agent-rpc';

const urlCache = new Map<string, Promise<string | null>>();

function normalizePath(path: string): string {
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function parseAttachmentPath(path: string): { projectId: string; filename: string } | null {
  const match = path.match(/^\/agent\/attachments\/([^/]+)\/(.+)$/);
  if (!match) {
    return null;
  }
  try {
    return {
      projectId: decodeURIComponent(match[1]),
      filename: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

export async function resolveAgentAttachmentUrl(urlPath: string): Promise<string | null> {
  const path = normalizePath(urlPath.trim());
  if (!path || path === '/') {
    return null;
  }
  const parsed = parseAttachmentPath(path);
  if (!parsed) {
    return null;
  }

  const cached = urlCache.get(path);
  if (cached) {
    return await cached;
  }

  const pending = (async () => {
    try {
      const blob = await requestAgentRpcBlob({
        operation: 'agent.attachments.get',
        params: {
          projectId: parsed.projectId,
          filename: parsed.filename,
        },
      });
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  })();

  urlCache.set(path, pending);
  return await pending;
}
