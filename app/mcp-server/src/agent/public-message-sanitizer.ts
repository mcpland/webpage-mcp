import type { AgentSessionPreviewMeta } from 'webpage-mcp-shared';

const WEB_EDITOR_CLIENT_META_KINDS = new Set(['web_editor_apply_batch', 'web_editor_apply_single']);
const REDACTED_PAGE_LABEL = '[redacted non-public page]';

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasDisallowedPublicUrlScheme(url: string): boolean {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!match) {
    return false;
  }

  const protocol = match[1]?.toLowerCase();
  return protocol !== 'http' && protocol !== 'https';
}

type PublicClientMeta = NonNullable<AgentSessionPreviewMeta['clientMeta']>;

function sanitizeClientMeta(
  clientMeta: unknown,
): { clientMeta?: PublicClientMeta; pageUrlRedacted: boolean } {
  if (!clientMeta || typeof clientMeta !== 'object') {
    return { clientMeta: undefined, pageUrlRedacted: false };
  }

  const raw = clientMeta as Record<string, unknown>;
  const kind = normalizeString(raw.kind);
  if (!WEB_EDITOR_CLIENT_META_KINDS.has(kind)) {
    return { clientMeta: undefined, pageUrlRedacted: false };
  }

  const pageUrl = normalizeString(raw.pageUrl);
  const isRedacted = pageUrl.length > 0 && hasDisallowedPublicUrlScheme(pageUrl);
  const elementCount = typeof raw.elementCount === 'number' ? raw.elementCount : undefined;
  const elementLabels = Array.isArray(raw.elementLabels)
    ? raw.elementLabels.filter((label): label is string => typeof label === 'string')
    : undefined;

  return {
    clientMeta: {
      kind: kind as PublicClientMeta['kind'],
      ...(isRedacted ? { pageUrl: null, pageUrlRedacted: true } : pageUrl ? { pageUrl } : {}),
      ...(typeof elementCount === 'number' ? { elementCount } : {}),
      ...(elementLabels ? { elementLabels } : {}),
    },
    pageUrlRedacted: isRedacted,
  };
}

export function sanitizeAgentMessageMetadata(
  metadata?: Record<string, unknown>,
): { metadata?: Record<string, unknown>; pageUrlRedacted: boolean } {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { metadata, pageUrlRedacted: false };
  }

  const { clientMeta, pageUrlRedacted } = sanitizeClientMeta(metadata.clientMeta);
  if (!clientMeta) {
    return { metadata, pageUrlRedacted: false };
  }

  return {
    metadata: {
      ...metadata,
      clientMeta,
    },
    pageUrlRedacted,
  };
}

export function sanitizeAgentMessageContent(content: string, pageUrlRedacted: boolean): string {
  if (!pageUrlRedacted) {
    return content;
  }
  return content.replace(/^Page URL:.*$/m, `Page URL: ${REDACTED_PAGE_LABEL}`);
}

export function sanitizeAgentMessageForPublicRead(params: {
  content: string;
  metadata?: Record<string, unknown>;
}): {
  content: string;
  metadata?: Record<string, unknown>;
  pageUrlRedacted: boolean;
} {
  const sanitizedMetadata = sanitizeAgentMessageMetadata(params.metadata);
  return {
    content: sanitizeAgentMessageContent(params.content, sanitizedMetadata.pageUrlRedacted),
    metadata: sanitizedMetadata.metadata,
    pageUrlRedacted: sanitizedMetadata.pageUrlRedacted,
  };
}
