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

function replaceNavigateValue(url: string, currentValue: string, placeholder: string): string {
  if (!currentValue) return url;
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url);
  try {
    const parsed = new URL(url, 'https://flow.local');
    let changed = false;
    const keys = Array.from(parsed.searchParams.keys());
    for (const key of keys) {
      const values = parsed.searchParams.getAll(key);
      const replaced = values.map((v) => {
        if (v === currentValue) {
          changed = true;
          return placeholder;
        }
        return v;
      });
      parsed.searchParams.delete(key);
      for (const value of replaced) {
        parsed.searchParams.append(key, value);
      }
    }
    if (changed) {
      if (hasScheme) return parsed.toString();
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // fallback below
  }

  if (!url.includes(currentValue)) return url;
  return url.split(currentValue).join(placeholder);
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
