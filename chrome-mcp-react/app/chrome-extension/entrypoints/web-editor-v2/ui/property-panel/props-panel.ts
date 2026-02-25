/**
 * Props Panel (Phase 7.3)
 *
 * Displays runtime component props (React/Vue) for the selected element.
 * Editing is performed via PropsBridge and applies immediately in the page.
 *
 * Features:
 * - Shows component name and framework
 * - Displays props with type information
 * - Supports editing primitive props (string/number/boolean)
 * - Shows capability status (canRead/canWrite/needsRefresh)
 * - Debounced writes to avoid high-frequency updates
 *
 * Constraints:
 * - Runtime-only (no source edits)
 * - Only supports editing top-level primitive props
 */

import type { ElementLocator } from '@/common/web-editor-types';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { createElementLocator } from '../../core/locator';
import type {
  FrameworkType,
  HookStatus,
  PropsBridge,
  PropsResponseData,
  SerializedPropEntry,
  SerializedValue,
} from '../../core/props-bridge';
import { Disposer } from '../../utils/disposables';
import type { DesignControl } from './types';

// =============================================================================
// Types
// =============================================================================

export interface PropsPanelOptions {
  container: HTMLElement;
  propsBridge: PropsBridge;
}

export interface PropsPanel extends DesignControl {
  setVisible(visible: boolean): void;
}

// =============================================================================
// Constants
// =============================================================================

const WRITE_DEBOUNCE_MS = 250;

const DANGEROUS_PROP_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

// =============================================================================
// Helpers
// =============================================================================

function isDangerousPropKey(key: string): boolean {
  return DANGEROUS_PROP_KEYS.has(String(key ?? '').trim());
}

function formatFramework(framework: FrameworkType | undefined, version?: string): string {
  // Only show version for known frameworks to avoid "Unknown x.y.z" display
  if (framework === 'react') {
    const trimmedVersion = version?.trim();
    return trimmedVersion ? `React ${trimmedVersion}` : 'React';
  }
  if (framework === 'vue') {
    const trimmedVersion = version?.trim();
    return trimmedVersion ? `Vue ${trimmedVersion}` : 'Vue';
  }
  return 'Unknown';
}

function formatHookStatus(hookStatus: HookStatus | undefined): string {
  return hookStatus ? String(hookStatus) : '';
}

/**
 * Format debug source for display.
 * Returns empty string if source is invalid/missing.
 */
function formatDebugSource(source: unknown): string {
  if (!source || typeof source !== 'object') return '';

  const rec = source as Record<string, unknown>;
  const file = typeof rec.file === 'string' ? rec.file.trim() : '';
  if (!file) return '';

  const lineRaw = Number(rec.line);
  const columnRaw = Number(rec.column);
  const line = Number.isFinite(lineRaw) && lineRaw > 0 ? lineRaw : undefined;
  const column = Number.isFinite(columnRaw) && columnRaw > 0 ? columnRaw : undefined;

  if (!line) return file;
  return column ? `${file}:${line}:${column}` : `${file}:${line}`;
}

function formatSerializedValue(value: SerializedValue): string {
  switch (value.kind) {
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'number':
      if (value.special) return value.special;
      if (typeof value.value === 'number') return String(value.value);
      return 'NaN';
    case 'string':
      return value.truncated ? `"${value.value}…"` : JSON.stringify(value.value);
    case 'bigint':
      return `${value.value}n`;
    case 'symbol':
      return `Symbol(${value.description})`;
    case 'function':
      return `ƒ ${value.name ?? '(anonymous)'}`;
    case 'react_element':
      return value.display;
    case 'dom_element': {
      const tag = String(value.tagName ?? '').toLowerCase() || 'element';
      const id = value.id ? `#${value.id}` : '';
      const cls = value.className
        ? `.${String(value.className).split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`
        : '';
      return `<${tag}${id}${cls}>`;
    }
    case 'date':
      return value.value;
    case 'regexp':
      return `/${value.source}/${value.flags}`;
    case 'error':
      return `${value.name}: ${value.message}`;
    case 'circular':
      return `[Circular #${value.refId}]`;
    case 'max_depth':
      return value.preview;
    case 'array':
      return `Array(${value.length})`;
    case 'object':
      return `${value.name ?? 'Object'} {…}`;
    case 'map':
      return `Map(${value.size})`;
    case 'set':
      return `Set(${value.size})`;
    case 'unknown':
      return value.preview;
    default:
      return String((value as { kind?: string }).kind ?? 'unknown');
  }
}

function canRenderEditableNumber(value: Extract<SerializedValue, { kind: 'number' }>): boolean {
  if (value.special) return false;
  if (typeof value.value !== 'number') return false;
  return Number.isFinite(value.value);
}

function parseNumberInput(raw: string): { ok: true; value: number } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false };

  // Accept intermediate "10." as 10 (keeps UX consistent with style controls)
  if (/^-?\d+\.$/.test(trimmed)) {
    const n = Number(trimmed.slice(0, -1));
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
  }

  // Pure number patterns: "10", "-10", "10.5", ".5", "-.5"
  if (/^-?(?:\d+|\d*\.\d+)$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
  }

  return { ok: false };
}

function mergeResponseData(
  prev: PropsResponseData | null,
  next: PropsResponseData | undefined,
): PropsResponseData | null {
  if (!next) return prev;
  if (!prev) return next;

  return {
    ...prev,
    ...next,
    capabilities: next.capabilities ?? prev.capabilities,
    props: next.props ?? prev.props,
    meta: { ...(prev.meta ?? {}), ...(next.meta ?? {}) },
  };
}

function buildStatusLine(
  loading: boolean,
  data: PropsResponseData | null,
  error: string | null,
): string {
  if (loading) return 'Loading…';

  if (!data) {
    return error ? `Error • ${error}` : 'Waiting for selection…';
  }

  const parts: string[] = [];
  const caps = data.capabilities;

  if (caps) {
    parts.push(`read: ${caps.canRead ? 'yes' : 'no'}`);
    parts.push(`write: ${caps.canWrite ? 'yes' : 'no'}`);
  } else {
    parts.push('read: unknown');
    parts.push('write: unknown');
  }

  const hook = formatHookStatus(data.hookStatus);
  if (hook) parts.push(`hook: ${hook}`);

  if (data.needsRefresh) parts.push('needs refresh');
  if (error) parts.push('error');

  return parts.join(' • ');
}

function getCanWrite(data: PropsResponseData | null): boolean {
  return Boolean(data?.capabilities?.canWrite) && !data?.needsRefresh;
}

function getCanRead(data: PropsResponseData | null): boolean {
  return Boolean(data?.capabilities?.canRead);
}

function findPropEntry(data: PropsResponseData | null, key: string): SerializedPropEntry | null {
  const props = data?.props;
  if (!props || !Array.isArray(props.entries)) return null;
  return props.entries.find((e) => e.key === key) ?? null;
}

function setInputFromEntry(entry: SerializedPropEntry, input: HTMLInputElement): void {
  input.classList.remove('we-props-input--invalid');

  if (entry.value.kind === 'string') {
    input.value = entry.value.value ?? '';
    return;
  }

  if (entry.value.kind === 'number') {
    if (typeof entry.value.value === 'number' && Number.isFinite(entry.value.value)) {
      input.value = String(entry.value.value);
    } else if (entry.value.special) {
      input.value = entry.value.special;
    } else {
      input.value = '';
    }
    return;
  }

  if (entry.value.kind === 'boolean') {
    input.checked = Boolean(entry.value.value);
  }
}

function updateLocalPrimitiveSnapshot(
  data: PropsResponseData | null,
  key: string,
  value: string | number | boolean,
): void {
  if (!data?.props?.entries) return;
  const entry = data.props.entries.find((e) => e.key === key);
  if (!entry) return;

  if (typeof value === 'string') {
    entry.value = { kind: 'string', value };
    entry.editable = true;
    return;
  }

  if (typeof value === 'number') {
    entry.value = { kind: 'number', value };
    entry.editable = true;
    return;
  }

  entry.value = { kind: 'boolean', value };
  entry.editable = true;
}

// =============================================================================
// Factory
// =============================================================================

export function createPropsPanel(options: PropsPanelOptions): PropsPanel {
  const { container, propsBridge } = options;
  const disposer = new Disposer();

  // ==========================================================================
  // Tooltip - fixed position at shadow root level to avoid overflow clipping
  // ==========================================================================

  const tooltip = document.createElement('div');
  tooltip.className = 'we-tooltip';
  tooltip.hidden = true;

  const rootNode = container.getRootNode();
  if (rootNode instanceof ShadowRoot) {
    rootNode.appendChild(tooltip);
  } else {
    document.body.appendChild(tooltip);
  }
  disposer.add(() => tooltip.remove());

  function showTooltip(el: Element): void {
    const text = el.getAttribute('data-tip');
    if (!text) {
      tooltip.hidden = true;
      return;
    }
    const rect = el.getBoundingClientRect();
    tooltip.textContent = text;
    tooltip.style.left = `${rect.left + rect.width / 2}px`;
    tooltip.style.top = `${rect.bottom + 4}px`;
    tooltip.hidden = false;
  }

  function hideTooltip(): void {
    tooltip.hidden = true;
  }

  // State
  let currentTarget: Element | null = null;
  let currentLocator: ElementLocator | null = null;
  let isVisible = false;
  let needsFetchOnVisible = false; // Deferred fetch when panel becomes visible
  let loading = false;
  let sessionId = 0;

  let lastData: PropsResponseData | null = null;
  let lastError: string | null = null;

  type PendingWrite = { timeoutId: number; value: string | number | boolean };
  const pendingWrites = new Map<string, PendingWrite>();

  // ==========================================================================
  // DOM Structure
  // ==========================================================================

  const root = document.createElement('div');
  root.className = 'we-props-panel';

  // Meta section
  const meta = document.createElement('div');
  meta.className = 'we-props-meta';

  const metaTitleRow = document.createElement('div');
  metaTitleRow.className = 'we-props-meta-title';

  const titleLeft = document.createElement('div');
  titleLeft.className = 'we-props-title-left';

  const componentEl = document.createElement('div');
  componentEl.className = 'we-props-component';
  componentEl.textContent = 'Props';

  const frameworkEl = document.createElement('span');
  frameworkEl.className = 'we-props-badge';
  frameworkEl.textContent = 'Unknown';

  titleLeft.append(componentEl, frameworkEl);

  // Action buttons in title row (icon style)
  const titleActions = document.createElement('div');
  titleActions.className = 'we-props-title-actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'we-props-action-btn';
  refreshBtn.dataset.tip = 'Refresh';
  refreshBtn.setAttribute('aria-label', 'Refresh props');
  // Refresh icon (circular arrow)
  refreshBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M11.5 7C11.5 9.48528 9.48528 11.5 7 11.5C4.51472 11.5 2.5 9.48528 2.5 7C2.5 4.51472 4.51472 2.5 7 2.5C8.5 2.5 9.83 3.25 10.6 4.4M10.6 2V4.4H8.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'we-props-action-btn';
  resetBtn.dataset.tip = 'Reset';
  resetBtn.setAttribute('aria-label', 'Reset props changes');
  // Reset icon (undo arrow)
  resetBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 5.5H8.5C10.1569 5.5 11.5 6.84315 11.5 8.5C11.5 10.1569 10.1569 11.5 8.5 11.5H7M3 5.5L5.5 3M3 5.5L5.5 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  titleActions.append(refreshBtn, resetBtn);
  metaTitleRow.append(titleLeft, titleActions);

  const statusEl = document.createElement('div');
  statusEl.className = 'we-props-status';

  const warningEl = document.createElement('div');
  warningEl.className = 'we-props-warning';
  warningEl.hidden = true;

  const errorEl = document.createElement('div');
  errorEl.className = 'we-props-error';
  errorEl.hidden = true;

  // Source row - shows component source file location with "Open in VSCode" button
  const sourceRow = document.createElement('div');
  sourceRow.className = 'we-props-source';
  sourceRow.hidden = true;

  const sourceLabelEl = document.createElement('span');
  sourceLabelEl.className = 'we-props-source-label';
  sourceLabelEl.textContent = 'Source';

  const sourcePathEl = document.createElement('span');
  sourcePathEl.className = 'we-props-source-path';
  sourcePathEl.title = ''; // Will be set to full path on render

  const openSourceBtn = document.createElement('button');
  openSourceBtn.type = 'button';
  openSourceBtn.className = 'we-props-source-btn';
  openSourceBtn.dataset.tip = 'Open in VSCode';
  openSourceBtn.setAttribute('aria-label', 'Open in VSCode');
  // Simple arrow pointing to top-right (external link style)
  openSourceBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3.5 2.5H9.5V8.5M9 3L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  sourceRow.append(sourceLabelEl, sourcePathEl, openSourceBtn);

  meta.append(metaTitleRow, statusEl, warningEl, errorEl, sourceRow);

  // List section
  const list = document.createElement('div');
  list.className = 'we-props-list';

  const emptyState = document.createElement('div');
  emptyState.className = 'we-props-empty';
  emptyState.textContent = 'Select an element to view props.';

  const rows = document.createElement('div');
  rows.className = 'we-props-rows';

  list.append(emptyState, rows);
  root.append(meta, list);
  container.append(root);
  disposer.add(() => root.remove());

  // ==========================================================================
  // Pending Writes Management
  // ==========================================================================

  function clearAllPendingWrites(): void {
    for (const [, entry] of pendingWrites) {
      clearTimeout(entry.timeoutId);
    }
    pendingWrites.clear();
  }

  /**
   * Flush all pending writes to the current target before switching elements.
   * This ensures user edits are not lost when selection changes quickly.
   */
  function flushAllPendingWrites(): void {
    if (pendingWrites.size === 0) return;

    const keys = [...pendingWrites.keys()];
    for (const key of keys) {
      const entry = pendingWrites.get(key);
      if (!entry) continue;
      clearTimeout(entry.timeoutId);
      pendingWrites.delete(key);
      void commitWrite(key, entry.value);
    }
  }

  disposer.add(clearAllPendingWrites);

  function cancelPendingWrite(key: string): void {
    const existing = pendingWrites.get(key);
    if (!existing) return;
    clearTimeout(existing.timeoutId);
    pendingWrites.delete(key);
  }

  function flushPendingWrite(key: string): void {
    const existing = pendingWrites.get(key);
    if (!existing) return;
    clearTimeout(existing.timeoutId);
    pendingWrites.delete(key);
    void commitWrite(key, existing.value);
  }

  function scheduleWrite(key: string, value: string | number | boolean): void {
    cancelPendingWrite(key);
    const timeoutId = window.setTimeout(() => {
      pendingWrites.delete(key);
      void commitWrite(key, value);
    }, WRITE_DEBOUNCE_MS);
    pendingWrites.set(key, { timeoutId, value });
  }

  // ==========================================================================
  // Render Functions
  // ==========================================================================

  function renderMeta(): void {
    const hasTarget = Boolean(currentTarget && currentTarget.isConnected);
    const framework = lastData?.framework;
    const frameworkVersion = lastData?.frameworkVersion;
    const componentName = lastData?.componentName;

    componentEl.textContent = componentName || 'Props';
    frameworkEl.textContent = formatFramework(framework, frameworkVersion);

    statusEl.textContent = hasTarget
      ? buildStatusLine(loading, lastData, lastError)
      : 'Select an element to view props.';

    // Warning messages
    warningEl.hidden = true;
    warningEl.textContent = '';

    if (hasTarget) {
      if (lastData?.needsRefresh) {
        warningEl.hidden = false;
        warningEl.textContent = 'A page refresh is required for full props inspection/editing.';
      } else if (lastData?.hookStatus === 'RENDERERS_NO_EDITING') {
        warningEl.hidden = false;
        warningEl.textContent =
          'Editing is unavailable (likely a production build without overrideProps).';
      } else if (lastData?.props?.truncated) {
        warningEl.hidden = false;
        warningEl.textContent = 'Props list is truncated.';
      }
    }

    // Error display
    errorEl.hidden = !lastError;
    errorEl.textContent = lastError ?? '';

    // Source display - show component file location with Open button
    const sourceText = hasTarget ? formatDebugSource(lastData?.debugSource) : '';
    sourceRow.hidden = !sourceText;
    sourcePathEl.textContent = sourceText;
    sourcePathEl.title = sourceText; // Show full path on hover
    openSourceBtn.disabled = !sourceText || loading;

    // Update refresh button state and tooltip
    const hookStatus = lastData?.hookStatus;
    const canBenefitFromEarlyInjection =
      hookStatus === 'HOOK_MISSING' || hookStatus === 'HOOK_PRESENT_NO_RENDERERS';
    const showEnableReload = lastData?.needsRefresh && canBenefitFromEarlyInjection;
    refreshBtn.dataset.tip = showEnableReload ? 'Enable & Reload' : 'Refresh';
    refreshBtn.disabled = !hasTarget || loading;
    resetBtn.disabled = !hasTarget || loading || !getCanWrite(lastData);
  }

  function renderList(): void {
    rows.innerHTML = '';

    const hasTarget = Boolean(currentTarget && currentTarget.isConnected);
    const data = lastData;

    if (!hasTarget) {
      emptyState.hidden = false;
      emptyState.classList.remove('we-loading');
      emptyState.textContent = 'Select an element to view props.';
      return;
    }

    if (loading) {
      emptyState.hidden = false;
      emptyState.classList.add('we-loading');
      // Spinner icon (thin stroke) + text
      emptyState.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="animation: we-spin 0.8s linear infinite;">
        <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-dasharray="20 14" />
      </svg><span>Loading props…</span>`;
      return;
    }

    // Remove loading class when not loading
    emptyState.classList.remove('we-loading');

    const canRead = getCanRead(data);
    if (!canRead) {
      emptyState.hidden = false;
      const hook = data?.hookStatus;
      if (data?.needsRefresh || hook === 'HOOK_MISSING' || hook === 'HOOK_PRESENT_NO_RENDERERS') {
        emptyState.textContent =
          'Props inspection is not ready. Refresh the page in development mode.';
      } else if (hook === 'RENDERERS_NO_EDITING') {
        emptyState.textContent = 'Props inspection/editing is unavailable in this build.';
      } else {
        emptyState.textContent = 'Props inspection is not available for this element.';
      }
      return;
    }

    const props = data?.props;
    if (!props || !Array.isArray(props.entries) || props.entries.length === 0) {
      emptyState.hidden = false;
      emptyState.textContent =
        data?.framework === 'vue' ? 'No props or attrs found.' : 'No props found.';
      return;
    }

    emptyState.hidden = true;

    const canWrite = getCanWrite(data);
    const disableEdits = !canWrite || loading;

    // Group entries by source for Vue (Props vs Attrs)
    const isVue = data?.framework === 'vue';
    const entries = props.entries;
    const hasAttrs = isVue && entries.some((e) => e.source === 'attrs');

    interface EntryGroup {
      title: string;
      entries: typeof entries;
    }

    const groups: EntryGroup[] = hasAttrs
      ? [
          { title: 'Props', entries: entries.filter((e) => e.source !== 'attrs') },
          { title: 'Attrs', entries: entries.filter((e) => e.source === 'attrs') },
        ].filter((g) => g.entries.length > 0)
      : [{ title: '', entries }];

    for (const group of groups) {
      // Render group header for Vue
      if (group.title) {
        const groupHeader = document.createElement('div');
        groupHeader.className = 'we-props-group';
        groupHeader.textContent = group.title;
        rows.append(groupHeader);
      }

      for (const entry of group.entries) {
        const row = document.createElement('div');
        row.className = 'we-props-row';

        const keyEl = document.createElement('div');
        keyEl.className = 'we-props-key';
        keyEl.textContent = entry.key;

        const valueEl = document.createElement('div');
        valueEl.className = 'we-props-value';

        const keyIsDangerous = isDangerousPropKey(entry.key);
        const entryEditable = Boolean(entry.editable) && !keyIsDangerous;

        // Check if this entry has enum values (for select rendering)
        // Filter to valid string enum values first, then check if non-empty
        const rawEnumValues = Array.isArray(entry.enumValues) ? entry.enumValues : [];
        const filteredEnumValues = rawEnumValues.filter(
          (v): v is string => typeof v === 'string' && v.trim().length > 0,
        );
        const hasEnumValues =
          entryEditable && entry.value.kind === 'string' && filteredEnumValues.length > 0;

        // Render editable controls for primitives
        if (hasEnumValues) {
          // Render Select for enum props
          const select = document.createElement('select');
          select.className = 'we-select we-props-input';
          select.disabled = disableEdits;
          select.dataset.propKey = entry.key;
          select.dataset.propKind = 'enum';
          select.setAttribute('aria-label', `Select prop ${entry.key}`);

          const currentValue = entry.value.value ?? '';
          const seen = new Set<string>();

          // Add current value first if not in enum list
          if (currentValue && !filteredEnumValues.includes(currentValue)) {
            const opt = document.createElement('option');
            opt.value = currentValue;
            opt.textContent = `${currentValue} (current)`;
            select.append(opt);
            seen.add(currentValue);
          }

          // Add enum values
          for (const v of filteredEnumValues) {
            if (seen.has(v)) continue;
            seen.add(v);
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            select.append(opt);
          }

          // Set current value
          if (currentValue && seen.has(currentValue)) {
            select.value = currentValue;
          }

          valueEl.append(select);
        } else if (entryEditable && entry.value.kind === 'boolean') {
          const label = document.createElement('label');
          label.className = 'we-props-bool';

          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'we-props-checkbox';
          checkbox.checked = Boolean(entry.value.value);
          checkbox.disabled = disableEdits;
          checkbox.dataset.propKey = entry.key;
          checkbox.dataset.propKind = 'boolean';
          checkbox.setAttribute('aria-label', `Toggle prop ${entry.key}`);

          const text = document.createElement('span');
          text.textContent = checkbox.checked ? 'true' : 'false';
          text.dataset.weBoolText = '1';

          label.append(checkbox, text);
          valueEl.append(label);
        } else if (entryEditable && entry.value.kind === 'string') {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'we-input we-props-input';
          input.autocomplete = 'off';
          input.spellcheck = false;
          input.value = entry.value.value ?? '';
          input.disabled = disableEdits;
          input.dataset.propKey = entry.key;
          input.dataset.propKind = 'string';
          input.setAttribute('aria-label', `Edit prop ${entry.key}`);
          valueEl.append(input);
        } else if (
          entryEditable &&
          entry.value.kind === 'number' &&
          canRenderEditableNumber(entry.value)
        ) {
          const input = document.createElement('input');
          input.type = 'text';
          input.inputMode = 'decimal';
          input.className = 'we-input we-props-input';
          input.autocomplete = 'off';
          input.spellcheck = false;
          input.value = String(entry.value.value);
          input.disabled = disableEdits;
          input.dataset.propKey = entry.key;
          input.dataset.propKind = 'number';
          input.setAttribute('aria-label', `Edit prop ${entry.key}`);
          valueEl.append(input);
        } else {
          // Read-only display
          valueEl.classList.add('we-props-value--readonly');
          valueEl.textContent = keyIsDangerous
            ? `${formatSerializedValue(entry.value)} (blocked)`
            : formatSerializedValue(entry.value);
        }

        row.append(keyEl, valueEl);
        rows.append(row);
      }
    }
  }

  function renderAll(): void {
    renderMeta();
    renderList();
  }

  // ==========================================================================
  // Data Fetching
  // ==========================================================================

  async function probeAndRead(): Promise<void> {
    if (disposer.isDisposed) return;

    if (!isVisible) {
      needsFetchOnVisible = true;
      return;
    }

    const target = currentTarget;
    const locator = currentLocator;

    if (!target || !target.isConnected || !locator) {
      lastData = null;
      lastError = null;
      loading = false;
      needsFetchOnVisible = false;
      renderAll();
      return;
    }

    const localSession = sessionId;
    loading = true;
    lastError = null;
    renderAll();

    try {
      const probeResult = await propsBridge.probe(locator);
      if (disposer.isDisposed || localSession !== sessionId) return;

      lastData = mergeResponseData(lastData, probeResult.data);
      if (!probeResult.ok) {
        lastError = probeResult.error ?? 'Props probe failed';
      }

      const canRead = Boolean(probeResult.data?.capabilities?.canRead);
      if (canRead) {
        const readResult = await propsBridge.read(locator);
        if (disposer.isDisposed || localSession !== sessionId) return;

        lastData = mergeResponseData(lastData, readResult.data);
        if (!readResult.ok) {
          lastError = readResult.error ?? 'Props read failed';
        }
      }
    } catch (err) {
      if (disposer.isDisposed || localSession !== sessionId) return;
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      if (!disposer.isDisposed && localSession === sessionId) {
        loading = false;
        needsFetchOnVisible = false;
        renderAll();
      }
    }
  }

  async function commitWrite(key: string, value: string | number | boolean): Promise<void> {
    if (disposer.isDisposed) return;

    const target = currentTarget;
    const locator = currentLocator;
    if (!target || !target.isConnected || !locator) return;

    if (isDangerousPropKey(key)) {
      lastError = 'Blocked prop key (security)';
      renderMeta();
      return;
    }

    const localSession = sessionId;
    const canWrite = getCanWrite(lastData);
    if (!canWrite) {
      lastError = 'Props editing is not available for this element.';
      renderMeta();
      return;
    }

    try {
      const result = await propsBridge.write(locator, [key], value);
      if (disposer.isDisposed || localSession !== sessionId) return;

      lastData = mergeResponseData(lastData, result.data);

      if (!result.ok) {
        lastError = result.error ?? 'Props write failed';
        renderMeta();
        return;
      }

      lastError = null;
      updateLocalPrimitiveSnapshot(lastData, key, value);
      renderMeta();
    } catch (err) {
      if (disposer.isDisposed || localSession !== sessionId) return;
      lastError = err instanceof Error ? err.message : String(err);
      renderMeta();
    }
  }

  async function resetOverrides(): Promise<void> {
    if (disposer.isDisposed) return;

    const target = currentTarget;
    const locator = currentLocator;
    if (!target || !target.isConnected || !locator) return;

    const localSession = sessionId;
    clearAllPendingWrites();
    loading = true;
    lastError = null;
    renderAll();

    try {
      const result = await propsBridge.reset(locator);
      if (disposer.isDisposed || localSession !== sessionId) return;

      lastData = mergeResponseData(lastData, result.data);
      if (!result.ok) {
        lastError = result.error ?? 'Props reset failed';
      }
    } catch (err) {
      if (disposer.isDisposed || localSession !== sessionId) return;
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      if (!disposer.isDisposed && localSession === sessionId) {
        loading = false;
        renderMeta();
        // Re-read to refresh displayed props after reset
        void probeAndRead();
      }
    }
  }

  // ==========================================================================
  // Early Injection (Phase 7.1.6)
  // ==========================================================================

  /**
   * Register early injection and reload the page.
   * This allows capturing React DevTools hook before React initializes.
   */
  async function registerEarlyInjectionAndReload(): Promise<void> {
    if (disposer.isDisposed) return;

    // Verify chrome runtime is available
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      lastError = 'Chrome runtime API not available';
      renderMeta();
      return;
    }

    // Confirm with user
    const confirmed = window.confirm(
      'Props editing requires early injection to capture React renderers before they initialize.\n\n' +
        'This will:\n' +
        '• Register a content script for this site\n' +
        '• Reload the page immediately\n\n' +
        'After reload, enable the editor again to access full Props functionality.\n\n' +
        'Continue?',
    );
    if (!confirmed) return;

    try {
      const resp = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_PROPS_REGISTER_EARLY_INJECTION,
      });

      if (!resp?.success) {
        lastError = resp?.error ?? 'Failed to register early injection';
        renderMeta();
      }
      // If successful, page will reload automatically
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      renderMeta();
    }
  }

  /**
   * Send message to background to open source file in VSCode.
   */
  async function openSourceInVSCode(): Promise<void> {
    if (disposer.isDisposed) return;

    const debugSource = lastData?.debugSource;
    if (!debugSource || !formatDebugSource(debugSource)) return;

    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      lastError = 'Chrome runtime API not available';
      renderMeta();
      return;
    }

    try {
      const resp = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_OPEN_SOURCE,
        payload: { debugSource },
      });

      if (resp?.success === false) {
        lastError = resp?.error ?? 'Failed to open source in VSCode';
        renderMeta();
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      renderMeta();
    }
  }

  // ==========================================================================
  // Event Handlers
  // ==========================================================================

  // Tooltip events - bind directly to elements with data-tip
  const bindTooltip = (el: HTMLElement) => {
    disposer.listen(el, 'mouseenter', () => showTooltip(el));
    disposer.listen(el, 'mouseleave', hideTooltip);
  };
  bindTooltip(refreshBtn);
  bindTooltip(resetBtn);
  bindTooltip(openSourceBtn);

  disposer.listen(refreshBtn, 'click', (e) => {
    e.preventDefault();
    clearAllPendingWrites();

    // Only offer early injection for HOOK_MISSING or HOOK_PRESENT_NO_RENDERERS
    // (not for RENDERERS_NO_EDITING which is a production build issue)
    const hookStatus = lastData?.hookStatus;
    const canBenefitFromEarlyInjection =
      hookStatus === 'HOOK_MISSING' || hookStatus === 'HOOK_PRESENT_NO_RENDERERS';

    if (lastData?.needsRefresh && canBenefitFromEarlyInjection) {
      void registerEarlyInjectionAndReload();
      return;
    }

    void probeAndRead();
  });

  disposer.listen(resetBtn, 'click', (e) => {
    e.preventDefault();
    void resetOverrides();
  });

  disposer.listen(openSourceBtn, 'click', (e) => {
    e.preventDefault();
    void openSourceInVSCode();
  });

  // Delegate input events within the list
  disposer.listen(rows, 'input', (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.disabled) return;
    if (target.type === 'checkbox') return;

    const key = target.dataset.propKey ?? '';
    const kind = target.dataset.propKind ?? '';
    if (!key || !kind) return;
    if (isDangerousPropKey(key)) return;

    // Avoid dispatch during IME composition
    const ie = e as InputEvent;
    if (ie.isComposing) return;

    if (kind === 'string') {
      scheduleWrite(key, target.value);
      return;
    }

    if (kind === 'number') {
      const parsed = parseNumberInput(target.value);
      if (!target.value.trim()) {
        cancelPendingWrite(key);
        target.classList.remove('we-props-input--invalid');
        return;
      }

      if (!parsed.ok) {
        cancelPendingWrite(key);
        target.classList.add('we-props-input--invalid');
        return;
      }

      target.classList.remove('we-props-input--invalid');
      scheduleWrite(key, parsed.value);
    }
  });

  disposer.listen(rows, 'change', (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // Handle Select (enum) change
    if (target instanceof HTMLSelectElement) {
      if (target.disabled) return;
      const key = target.dataset.propKey ?? '';
      const kind = target.dataset.propKind ?? '';
      if (!key || kind !== 'enum') return;
      if (isDangerousPropKey(key)) return;
      void commitWrite(key, target.value);
      return;
    }

    // Handle checkbox change
    if (!(target instanceof HTMLInputElement)) return;
    if (target.disabled) return;
    if (target.type !== 'checkbox') return;

    const key = target.dataset.propKey ?? '';
    const kind = target.dataset.propKind ?? '';
    if (!key || kind !== 'boolean') return;
    if (isDangerousPropKey(key)) return;

    // Update the label text
    const label = target.closest('.we-props-bool');
    const text = label?.querySelector?.('span[data-we-bool-text="1"]') as HTMLSpanElement | null;
    if (text) text.textContent = target.checked ? 'true' : 'false';

    void commitWrite(key, target.checked);
  });

  disposer.listen(rows, 'keydown', (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.disabled) return;

    const key = target.dataset.propKey ?? '';
    const kind = target.dataset.propKind ?? '';
    if (!key || !kind) return;

    if (e.key === 'Enter') {
      if (e.isComposing) return;
      e.preventDefault();
      flushPendingWrite(key);
      try {
        target.blur();
      } catch {
        // Best-effort
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      cancelPendingWrite(key);

      const entry = findPropEntry(lastData, key);
      if (!entry) return;
      setInputFromEntry(entry, target);
    }
  });

  disposer.listen(rows, 'focusout', (e: FocusEvent) => {
    const target = e.target as HTMLElement | null;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.disabled) return;
    const key = target.dataset.propKey ?? '';
    const kind = target.dataset.propKind ?? '';
    if (!key) return;

    // For number inputs, restore last valid value if current is empty/invalid
    if (kind === 'number') {
      const parsed = parseNumberInput(target.value);
      if (!target.value.trim() || !parsed.ok) {
        cancelPendingWrite(key);
        target.classList.remove('we-props-input--invalid');
        const entry = findPropEntry(lastData, key);
        if (entry) setInputFromEntry(entry, target);
        return;
      }
    }

    flushPendingWrite(key);
  });

  // ==========================================================================
  // Public API
  // ==========================================================================

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;

    // Flush pending writes to the previous target before switching
    flushAllPendingWrites();

    sessionId += 1;

    currentTarget = element && element.isConnected ? element : null;
    currentLocator = currentTarget ? createElementLocator(currentTarget) : null;

    lastData = null;
    lastError = null;
    loading = false;
    needsFetchOnVisible = false;

    renderAll();

    if (isVisible) {
      void probeAndRead();
    } else {
      needsFetchOnVisible = true;
    }
  }

  function refresh(): void {
    if (disposer.isDisposed) return;
    clearAllPendingWrites();
    void probeAndRead();
  }

  function setVisible(visible: boolean): void {
    if (disposer.isDisposed) return;
    isVisible = visible;
    if (visible && needsFetchOnVisible) {
      void probeAndRead();
    }
  }

  function dispose(): void {
    currentTarget = null;
    currentLocator = null;
    lastData = null;
    lastError = null;
    loading = false;
    needsFetchOnVisible = false;
    disposer.dispose();
  }

  // Initial render
  renderAll();

  return {
    setTarget,
    refresh,
    setVisible,
    dispose,
  };
}
