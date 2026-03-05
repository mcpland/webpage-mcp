import type { Flow } from '../record-replay/types';

interface ParameterSuggestion {
  nodeId: string;
  kind: 'fill' | 'navigate';
  suggestedKey: string;
  currentValue: string;
}

export interface ApplyParameterSuggestionsResult {
  changed: boolean;
  applied: number;
  variablesAdded: number;
  skipped: number;
}

function isValidVariableKey(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function restorePlaceholderToken(url: string, placeholder: string): string {
  const encoded = encodeURIComponent(placeholder);
  if (!encoded || !url.includes('%7B')) return url;
  const pattern = new RegExp(escapeRegExp(encoded), 'gi');
  return url.replace(pattern, placeholder);
}

function decodeQueryValue(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, '%20'));
  } catch {
    return raw;
  }
}

function replaceInQueryString(
  url: string,
  currentValue: string,
  placeholder: string,
): { url: string; changed: boolean } {
  const hashIndex = url.indexOf('#');
  const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const queryIndex = beforeHash.indexOf('?');
  if (queryIndex < 0) return { url, changed: false };

  const base = beforeHash.slice(0, queryIndex);
  const query = beforeHash.slice(queryIndex + 1);
  const segments = query.split('&');
  let changed = false;

  const replaced = segments.map((segment) => {
    const eqIndex = segment.indexOf('=');
    if (eqIndex < 0) return segment;
    const key = segment.slice(0, eqIndex);
    const rawValue = segment.slice(eqIndex + 1);
    const decodedValue = decodeQueryValue(rawValue);
    if (decodedValue === currentValue || rawValue === currentValue) {
      changed = true;
      return `${key}=${placeholder}`;
    }
    return segment;
  });

  if (!changed) return { url, changed: false };
  return { url: `${base}?${replaced.join('&')}${hash}`, changed: true };
}

function replaceNavigateValue(url: string, currentValue: string, placeholder: string): string {
  if (!currentValue) return url;
  const replaced = replaceInQueryString(url, currentValue, placeholder);
  if (!replaced.changed) return url;
  return restorePlaceholderToken(replaced.url, placeholder);
}

function normalizeSuggestions(flow: Flow): ParameterSuggestion[] {
  const list = flow.meta?.recording?.parameterSuggestions;
  if (!Array.isArray(list)) return [];
  const result: ParameterSuggestion[] = [];
  for (const item of list) {
    const nodeId = typeof item?.nodeId === 'string' ? item.nodeId.trim() : '';
    const kind = item?.kind;
    const suggestedKey = typeof item?.suggestedKey === 'string' ? item.suggestedKey.trim() : '';
    const currentValue = typeof item?.currentValue === 'string' ? item.currentValue : '';
    if (!nodeId) continue;
    if (kind !== 'fill' && kind !== 'navigate') continue;
    if (!isValidVariableKey(suggestedKey)) continue;
    result.push({ nodeId, kind, suggestedKey, currentValue });
  }
  return result;
}

export function applyFlowParameterSuggestions(flow: Flow): ApplyParameterSuggestionsResult {
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  if (!nodes.length) {
    return { changed: false, applied: 0, variablesAdded: 0, skipped: 0 };
  }

  const suggestions = normalizeSuggestions(flow);
  if (!suggestions.length) {
    return { changed: false, applied: 0, variablesAdded: 0, skipped: 0 };
  }

  const existingVariables = new Set((flow.variables || []).map((v) => v.key));
  if (!Array.isArray(flow.variables)) {
    flow.variables = [];
  }

  let changed = false;
  let applied = 0;
  let variablesAdded = 0;
  let skipped = 0;

  for (const suggestion of suggestions) {
    const node = nodes.find((candidate) => candidate?.id === suggestion.nodeId);
    if (!node || !node.config || typeof node.config !== 'object') {
      skipped += 1;
      continue;
    }

    const placeholder = `{${suggestion.suggestedKey}}`;
    if (suggestion.kind === 'fill') {
      if (node.type !== 'fill') {
        skipped += 1;
        continue;
      }
      const currentValue = (node.config as any).value;
      if (typeof currentValue !== 'string') {
        skipped += 1;
        continue;
      }
      if (currentValue !== placeholder) {
        (node.config as any).value = placeholder;
        changed = true;
      }
    } else {
      if (node.type !== 'navigate') {
        skipped += 1;
        continue;
      }
      const currentUrl = (node.config as any).url;
      if (typeof currentUrl !== 'string' || !currentUrl.trim()) {
        skipped += 1;
        continue;
      }
      const nextUrl = replaceNavigateValue(currentUrl, suggestion.currentValue, placeholder);
      if (nextUrl !== currentUrl) {
        (node.config as any).url = nextUrl;
        changed = true;
      }
    }

    if (!existingVariables.has(suggestion.suggestedKey)) {
      flow.variables!.push({
        key: suggestion.suggestedKey,
        label: suggestion.suggestedKey,
        type: 'string',
        default: suggestion.currentValue,
      });
      existingVariables.add(suggestion.suggestedKey);
      variablesAdded += 1;
      changed = true;
    }

    applied += 1;
  }

  return { changed, applied, variablesAdded, skipped };
}
