import {
  AGENT_IDENTIFIER_MAX_BYTES,
  AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES,
  AGENT_MESSAGE_CONTENT_MAX_BYTES,
  AGENT_MESSAGE_METADATA_MAX_JSON_BYTES,
} from 'webpage-mcp-shared';
import type { ClaudeManagementInfo } from './types';
import { redactDiagnosticText } from './diagnostic-redaction';

export const CLAUDE_EVENT_FIELD_MAX_BYTES = 16 * 1024;
export const CLAUDE_EVENT_LOG_MAX_BYTES = 16 * 1024;
export const CLAUDE_EVENT_ERROR_MAX_BYTES = 64 * 1024;
export const CLAUDE_SESSION_ID_MAX_BYTES = AGENT_IDENTIFIER_MAX_BYTES;
export const CLAUDE_MANAGEMENT_MAX_ENTRIES_PER_FIELD = 128;
export const CLAUDE_MANAGEMENT_SCAN_MAX_ENTRIES = 256;
export const CLAUDE_MANAGEMENT_STRING_MAX_BYTES = 8 * 1024;
export const CLAUDE_AUTH_OUTPUT_MAX_ENTRIES = 64;
export const CLAUDE_AUTH_OUTPUT_SCAN_MAX_ENTRIES = 128;
export const CLAUDE_AUTH_OUTPUT_ENTRY_MAX_BYTES = 4 * 1024;
export const CLAUDE_AUTH_OUTPUT_TOTAL_MAX_BYTES = 12 * 1024;
export const CLAUDE_AUTH_ERROR_MAX_BYTES = 8 * 1024;
export const CLAUDE_TOOL_COLLECTION_MAX_ENTRIES = 64;
export const CLAUDE_TOOL_COLLECTION_SCAN_MAX_ENTRIES = 128;
export const CLAUDE_TOOL_COLLECTION_MAX_JSON_BYTES = 32 * 1024;
export const CLAUDE_TOOL_METADATA_IDENTITY_MAX_BYTES = 2 * 1024;
export const CLAUDE_TOOL_METADATA_FIELD_MAX_BYTES = 4 * 1024;
export const CLAUDE_TOOL_ID_MAX_BYTES = 240;
export const CLAUDE_LINE_SCAN_MAX_CODE_UNITS = 64 * 1024;
export const CLAUDE_MESSAGE_CONTENT_MAX_ENTRIES = 128;

const TRUNCATION_MARKER = '\n\n… [truncated]';
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
const LOG_TRUNCATION_MARKER = ' … [truncated]';

export interface BoundedClaudeText {
  text: string;
  truncated: boolean;
  retainedBytes: number;
  observedBytes: number;
}

function utf8Width(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function scanUtf8Prefix(
  value: string,
  maximumBytes: number,
): { end: number; bytes: number; truncated: boolean } {
  let end = 0;
  let bytes = 0;
  while (end < value.length) {
    const codePoint = value.codePointAt(end) ?? 0xfffd;
    const width = utf8Width(codePoint);
    if (bytes + width > maximumBytes) {
      return { end, bytes, truncated: true };
    }
    bytes += width;
    end += codePoint > 0xffff ? 2 : 1;
  }
  return { end, bytes, truncated: false };
}

/**
 * Return a UTF-8 prefix without encoding or scanning bytes beyond the budget.
 * When truncated, observedBytes is a lower bound rather than a full-input scan.
 */
function boundClaudeTextWithMarker(
  value: string,
  maximumBytes: number,
  marker: string,
): BoundedClaudeText {
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= markerBytes) {
    throw new RangeError('maximumBytes must exceed the Claude truncation marker');
  }

  const initial = scanUtf8Prefix(value, maximumBytes);
  if (!initial.truncated) {
    return {
      text: value,
      truncated: false,
      retainedBytes: initial.bytes,
      observedBytes: initial.bytes,
    };
  }

  const prefix = scanUtf8Prefix(value, maximumBytes - markerBytes);
  return {
    text: `${value.slice(0, prefix.end)}${marker}`,
    truncated: true,
    retainedBytes: prefix.bytes + markerBytes,
    observedBytes: maximumBytes + 1,
  };
}

export function boundClaudeEventText(
  value: string,
  maximumBytes = CLAUDE_EVENT_FIELD_MAX_BYTES,
): BoundedClaudeText {
  return boundClaudeTextWithMarker(value, maximumBytes, TRUNCATION_MARKER);
}

export function boundClaudeLogField(
  value: unknown,
  maximumBytes = CLAUDE_EVENT_LOG_MAX_BYTES,
): string {
  let text: string;
  if (value instanceof Error) text = value.message;
  else if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else if (value === null || value === undefined) text = String(value);
  else text = '[non-string value]';
  const bounded = boundClaudeEventText(text, maximumBytes).text;
  const singleLine = sanitizeBoundedText(bounded, true);
  return boundClaudeTextWithMarker(
    singleLine,
    maximumBytes,
    LOG_TRUNCATION_MARKER,
  ).text;
}

function sanitizeBoundedText(value: string, singleLine: boolean): string {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (singleLine && code === 13) chunks.push('\\r');
    else if (singleLine && code === 10) chunks.push('\\n');
    else if (singleLine && code === 9) chunks.push('\\t');
    else if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    ) {
      chunks.push('\uFFFD');
    } else {
      chunks.push(value[index]);
    }
  }
  return chunks.join('');
}

function boundMetadataText(value: string, maximumBytes: number): BoundedClaudeText {
  const initial = boundClaudeEventText(value, maximumBytes);
  const sanitized = sanitizeBoundedText(initial.text, false);
  const rebound = boundClaudeEventText(sanitized, maximumBytes);
  return {
    ...rebound,
    truncated: initial.truncated || rebound.truncated,
    observedBytes: initial.observedBytes,
  };
}

export function pickBoundedClaudeString(
  value: unknown,
  maximumBytes = CLAUDE_EVENT_FIELD_MAX_BYTES,
  maximumArrayEntries = 32,
): string | undefined {
  if (typeof value === 'string') {
    const bounded = boundClaudeEventText(value, maximumBytes).text.trim();
    return bounded || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const scanLimit = Math.min(value.length, maximumArrayEntries);
    for (let index = 0; index < scanLimit; index += 1) {
      const candidate = pickBoundedClaudeString(value[index], maximumBytes, 0);
      if (candidate) return candidate;
    }
  }
  return undefined;
}

export function pickBoundedClaudeIdentifier(
  value: unknown,
  maximumBytes: number,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const bounded = boundClaudeEventText(value, maximumBytes);
  if (bounded.truncated) return undefined;
  for (let index = 0; index < bounded.text.length; index += 1) {
    const code = bounded.text.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) return undefined;
  }
  return bounded.text.trim() || undefined;
}

export interface BoundedClaudeSessionId {
  id?: string;
  rejected: boolean;
  observedBytes: number;
}

export function parseBoundedClaudeSessionId(value: unknown): BoundedClaudeSessionId {
  if (typeof value !== 'string') {
    return { rejected: value !== undefined && value !== null, observedBytes: 0 };
  }
  const bounded = boundClaudeEventText(value, CLAUDE_SESSION_ID_MAX_BYTES);
  let containsControl = false;
  for (let index = 0; index < bounded.text.length; index += 1) {
    const code = bounded.text.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159)) {
      containsControl = true;
      break;
    }
  }
  if (bounded.truncated || containsControl) {
    return { rejected: true, observedBytes: bounded.observedBytes };
  }
  const id = bounded.text.trim();
  return {
    ...(id ? { id } : {}),
    rejected: false,
    observedBytes: bounded.retainedBytes,
  };
}

class JsonObjectBudget {
  public readonly value: Record<string, unknown> = {};
  private bytes = 2;
  private fieldCount = 0;

  public constructor(private readonly maximumBytes: number) {}

  public trySet(key: string, value: unknown): boolean {
    const serializedKey = JSON.stringify(key);
    const serializedValue = JSON.stringify(value);
    if (serializedValue === undefined) return false;
    const additional =
      (this.fieldCount > 0 ? 1 : 0) +
      Buffer.byteLength(serializedKey, 'utf8') +
      1 +
      Buffer.byteLength(serializedValue, 'utf8');
    if (this.bytes + additional > this.maximumBytes) return false;
    this.value[key] = value;
    this.bytes += additional;
    this.fieldCount += 1;
    return true;
  }

  public startArray(key: string): unknown[] | undefined {
    const target: unknown[] = [];
    if (!this.trySet(key, target)) return undefined;
    return target;
  }

  public tryAppend(target: unknown[], value: unknown): boolean {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return false;
    const additional =
      (target.length > 0 ? 1 : 0) + Buffer.byteLength(serialized, 'utf8');
    if (this.bytes + additional > this.maximumBytes) return false;
    target.push(value);
    this.bytes += additional;
    return true;
  }

  public get serializedBytes(): number {
    return this.bytes;
  }
}

export interface BoundedClaudeManagementInfo {
  info: ClaudeManagementInfo;
  truncated: boolean;
  truncatedFields: string[];
  serializedBytes: number;
}

function boundedManagementString(value: unknown): BoundedClaudeText | undefined {
  if (typeof value !== 'string') return undefined;
  const bounded = boundMetadataText(value, CLAUDE_MANAGEMENT_STRING_MAX_BYTES);
  const text = bounded.text.trim();
  return text ? { ...bounded, text } : undefined;
}

export function buildBoundedClaudeManagementInfo(
  record: Record<string, unknown>,
): BoundedClaudeManagementInfo {
  const budget = new JsonObjectBudget(AGENT_MANAGEMENT_INFO_MAX_JSON_BYTES);
  const truncatedFields = new Set<string>();

  const addScalar = (sourceKey: string, targetKey: keyof ClaudeManagementInfo): void => {
    const candidate = boundedManagementString(record[sourceKey]);
    if (!candidate) return;
    if (candidate.truncated || !budget.trySet(targetKey, candidate.text)) {
      truncatedFields.add(String(targetKey));
    }
  };

  addScalar('model', 'model');
  addScalar('permissionMode', 'permissionMode');
  addScalar('cwd', 'cwd');
  addScalar('output_style', 'outputStyle');
  addScalar('claude_code_version', 'claudeCodeVersion');
  addScalar('apiKeySource', 'apiKeySource');

  const addStringArray = (sourceKey: string, targetKey: keyof ClaudeManagementInfo): void => {
    const source = record[sourceKey];
    if (!Array.isArray(source)) return;
    const target = budget.startArray(String(targetKey));
    if (!target) {
      truncatedFields.add(String(targetKey));
      return;
    }

    const scanLimit = Math.min(source.length, CLAUDE_MANAGEMENT_SCAN_MAX_ENTRIES);
    let retained = 0;
    let inspected = 0;
    for (; inspected < scanLimit; inspected += 1) {
      if (retained >= CLAUDE_MANAGEMENT_MAX_ENTRIES_PER_FIELD) break;
      const candidate = boundedManagementString(source[inspected]);
      if (!candidate) continue;
      if (candidate.truncated) truncatedFields.add(String(targetKey));
      if (!budget.tryAppend(target, candidate.text)) {
        truncatedFields.add(String(targetKey));
        break;
      }
      retained += 1;
    }
    if (source.length > inspected) truncatedFields.add(String(targetKey));
  };

  addStringArray('tools', 'tools');
  addStringArray('agents', 'agents');
  addStringArray('skills', 'skills');
  addStringArray('slash_commands', 'slashCommands');
  addStringArray('betas', 'betas');

  const addPlugins = (): void => {
    const source = record.plugins;
    if (!Array.isArray(source)) return;
    const target = budget.startArray('plugins');
    if (!target) {
      truncatedFields.add('plugins');
      return;
    }
    const scanLimit = Math.min(source.length, CLAUDE_MANAGEMENT_SCAN_MAX_ENTRIES);
    let retained = 0;
    let inspected = 0;
    for (; inspected < scanLimit; inspected += 1) {
      if (retained >= CLAUDE_MANAGEMENT_MAX_ENTRIES_PER_FIELD) break;
      const raw = source[inspected];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const plugin = raw as Record<string, unknown>;
      const name = boundedManagementString(plugin.name);
      if (!name) continue;
      const pluginPath = boundedManagementString(plugin.path);
      if (name.truncated || pluginPath?.truncated) truncatedFields.add('plugins');
      const candidate = {
        name: name.text,
        ...(pluginPath ? { path: pluginPath.text } : {}),
      };
      if (!budget.tryAppend(target, candidate)) {
        truncatedFields.add('plugins');
        break;
      }
      retained += 1;
    }
    if (source.length > inspected) truncatedFields.add('plugins');
  };

  const addMcpServers = (): void => {
    const source = record.mcp_servers;
    if (!Array.isArray(source)) return;
    const target = budget.startArray('mcpServers');
    if (!target) {
      truncatedFields.add('mcpServers');
      return;
    }
    const scanLimit = Math.min(source.length, CLAUDE_MANAGEMENT_SCAN_MAX_ENTRIES);
    let retained = 0;
    let inspected = 0;
    for (; inspected < scanLimit; inspected += 1) {
      if (retained >= CLAUDE_MANAGEMENT_MAX_ENTRIES_PER_FIELD) break;
      const raw = source[inspected];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const server = raw as Record<string, unknown>;
      const name = boundedManagementString(server.name);
      if (!name) continue;
      const status = boundedManagementString(server.status);
      if (name.truncated || status?.truncated) truncatedFields.add('mcpServers');
      const candidate = { name: name.text, status: status?.text || 'unknown' };
      if (!budget.tryAppend(target, candidate)) {
        truncatedFields.add('mcpServers');
        break;
      }
      retained += 1;
    }
    if (source.length > inspected) truncatedFields.add('mcpServers');
  };

  addPlugins();
  addMcpServers();

  return {
    info: budget.value as ClaudeManagementInfo,
    truncated: truncatedFields.size > 0,
    truncatedFields: [...truncatedFields],
    serializedBytes: budget.serializedBytes,
  };
}

export interface ClaudeEventTruncationDetail {
  field: string;
  maximumBytes?: number;
  retainedEntries?: number;
  observedEntries?: number;
}

export interface BoundedClaudeAuthStatus {
  content: string;
  output: string[];
  error?: string;
  requiresLogin: boolean;
  truncated: boolean;
  truncation: ClaudeEventTruncationDetail[];
}

export function buildBoundedClaudeAuthStatus(
  record: Record<string, unknown>,
): BoundedClaudeAuthStatus {
  const output: string[] = [];
  const truncation: ClaudeEventTruncationDetail[] = [];
  let outputBytes = 0;
  let outputContainsLoginHint = false;
  const source = Array.isArray(record.output) ? record.output : [];
  const scanLimit = Math.min(source.length, CLAUDE_AUTH_OUTPUT_SCAN_MAX_ENTRIES);
  let inspected = 0;

  for (; inspected < scanLimit; inspected += 1) {
    if (output.length >= CLAUDE_AUTH_OUTPUT_MAX_ENTRIES) break;
    const raw = source[inspected];
    if (typeof raw !== 'string') continue;
    const separatorBytes = output.length > 0 ? 1 : 0;
    const remaining = CLAUDE_AUTH_OUTPUT_TOTAL_MAX_BYTES - outputBytes - separatorBytes;
    if (remaining <= TRUNCATION_MARKER_BYTES) break;
    const bounded = boundMetadataText(
      raw,
      Math.min(CLAUDE_AUTH_OUTPUT_ENTRY_MAX_BYTES, remaining),
    );
    const safeText = redactDiagnosticText(
      bounded.text,
      Math.min(CLAUDE_AUTH_OUTPUT_ENTRY_MAX_BYTES, remaining),
    );
    output.push(safeText);
    outputBytes += separatorBytes + Buffer.byteLength(safeText, 'utf8');
    if (bounded.truncated) {
      truncation.push({
        field: 'authOutputEntry',
        maximumBytes: CLAUDE_AUTH_OUTPUT_ENTRY_MAX_BYTES,
      });
    }
    const lower = safeText.toLowerCase();
    if (lower.includes('login') || lower.includes('authenticate') || lower.includes('sign in')) {
      outputContainsLoginHint = true;
    }
  }
  if (source.length > inspected) {
    truncation.push({
      field: 'authOutput',
      retainedEntries: output.length,
      observedEntries: Math.min(source.length, CLAUDE_AUTH_OUTPUT_SCAN_MAX_ENTRIES + 1),
    });
  }

  const rawError = pickBoundedClaudeString(record.error, CLAUDE_AUTH_ERROR_MAX_BYTES);
  let authError = rawError
    ? redactDiagnosticText(
        boundMetadataText(rawError, CLAUDE_AUTH_ERROR_MAX_BYTES).text,
        CLAUDE_AUTH_ERROR_MAX_BYTES,
      ).trim() || undefined
    : undefined;
  if (typeof record.error === 'string') {
    const boundedError = boundMetadataText(record.error, CLAUDE_AUTH_ERROR_MAX_BYTES);
    authError =
      redactDiagnosticText(boundedError.text, CLAUDE_AUTH_ERROR_MAX_BYTES).trim() || undefined;
    if (boundedError.truncated) {
      truncation.push({
        field: 'authError',
        maximumBytes: CLAUDE_AUTH_ERROR_MAX_BYTES,
      });
    }
  }

  return {
    content: authError || output.join('\n') || 'Authentication in progress...',
    output,
    ...(authError ? { error: authError } : {}),
    requiresLogin: Boolean(authError) || outputContainsLoginHint,
    truncated: truncation.length > 0,
    truncation,
  };
}

export interface BoundedLineCount {
  lines: number;
  truncated: boolean;
  scannedCodeUnits: number;
}

export function countClaudeLinesBounded(value: string): BoundedLineCount {
  const scanLimit = Math.min(value.length, CLAUDE_LINE_SCAN_MAX_CODE_UNITS);
  let lines = 1;
  for (let index = 0; index < scanLimit; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
  }
  return { lines, truncated: value.length > scanLimit, scannedCodeUnits: scanLimit };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildBoundedTodoSummary(
  value: unknown,
): { todos: Array<Record<string, unknown>>; truncated: boolean } {
  if (!Array.isArray(value)) return { todos: [], truncated: false };
  const todos: Array<Record<string, unknown>> = [];
  let serializedBytes = 2;
  const scanLimit = Math.min(value.length, CLAUDE_TOOL_COLLECTION_SCAN_MAX_ENTRIES);
  let inspected = 0;
  let truncated = false;
  for (; inspected < scanLimit; inspected += 1) {
    if (todos.length >= CLAUDE_TOOL_COLLECTION_MAX_ENTRIES) break;
    const raw = value[inspected];
    if (!isRecord(raw)) continue;
    const summary: Record<string, unknown> = {};
    for (const key of ['content', 'status', 'activeForm'] as const) {
      if (typeof raw[key] === 'string') {
        const bounded = boundMetadataText(raw[key], 2 * 1024);
        summary[key] = bounded.text;
        if (bounded.truncated) truncated = true;
      }
    }
    if (Object.keys(summary).length === 0) continue;
    const serialized = JSON.stringify(summary);
    const additional =
      (todos.length > 0 ? 1 : 0) + Buffer.byteLength(serialized, 'utf8');
    if (serializedBytes + additional > CLAUDE_TOOL_COLLECTION_MAX_JSON_BYTES) {
      truncated = true;
      break;
    }
    todos.push(summary);
    serializedBytes += additional;
  }
  if (value.length > inspected) truncated = true;
  return { todos, truncated };
}

function buildBoundedRawInputSummary(input: Record<string, unknown>): string {
  const summary: Record<string, unknown> = {};
  let inspected = 0;
  for (const key in input) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    inspected += 1;
    if (inspected > 32) break;
    const boundedKey = boundClaudeEventText(key, 128).text;
    const value = input[key];
    if (typeof value === 'string') {
      summary[boundedKey] = boundMetadataText(value, 512).text;
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      summary[boundedKey] = value;
    }
  }
  return boundClaudeEventText(JSON.stringify(summary), 2 * 1024).text;
}

function enforceToolMetadataJsonBudget(metadata: Record<string, unknown>): void {
  if (
    Buffer.byteLength(JSON.stringify(metadata), 'utf8') <=
    AGENT_MESSAGE_METADATA_MAX_JSON_BYTES
  ) {
    return;
  }

  metadata.truncated = true;
  const removableFields = [
    'rawInput',
    'todos',
    'contentPreview',
    'oldString',
    'newString',
    'commandDescription',
    'command',
    'glob',
    'searchPath',
    'pattern',
    'filePath',
  ];
  for (const field of removableFields) {
    delete metadata[field];
    if (
      Buffer.byteLength(JSON.stringify(metadata), 'utf8') <=
      AGENT_MESSAGE_METADATA_MAX_JSON_BYTES
    ) {
      return;
    }
  }
}

export function buildBoundedClaudeToolMetadata(
  toolNameValue: unknown,
  toolIdValue: unknown,
  inputValue: unknown,
  action?: string,
): Record<string, unknown> {
  const rawToolName = pickBoundedClaudeString(
    toolNameValue,
    CLAUDE_TOOL_METADATA_IDENTITY_MAX_BYTES,
  );
  const toolName = rawToolName
    ? boundMetadataText(rawToolName, CLAUDE_TOOL_METADATA_IDENTITY_MAX_BYTES).text
    : 'unknown';
  const rawToolId = pickBoundedClaudeIdentifier(
    toolIdValue,
    CLAUDE_TOOL_ID_MAX_BYTES,
  );
  const toolId = rawToolId
    ? boundMetadataText(rawToolId, CLAUDE_TOOL_ID_MAX_BYTES).text
    : undefined;
  const metadata: Record<string, unknown> = {
    toolName,
    tool_name: toolName,
    toolId,
    action,
  };
  if (!isRecord(inputValue)) return metadata;

  const input = inputValue;
  const truncation: ClaudeEventTruncationDetail[] = [];
  const addText = (
    targetKey: string,
    sourceKey: string,
    maximumBytes = CLAUDE_TOOL_METADATA_FIELD_MAX_BYTES,
  ): void => {
    const raw = input[sourceKey];
    if (typeof raw !== 'string') return;
    const bounded = boundMetadataText(raw, maximumBytes);
    metadata[targetKey] = bounded.text;
    if (bounded.truncated) truncation.push({ field: targetKey, maximumBytes });
  };

  const normalizedName = toolName.toLowerCase();
  addText('filePath', 'file_path');

  if (
    normalizedName.includes('edit') ||
    normalizedName === 'apply_patch' ||
    normalizedName === 'patch_file'
  ) {
    addText('oldString', 'old_string');
    addText('newString', 'new_string');
    if (typeof input.old_string === 'string') {
      const count = countClaudeLinesBounded(input.old_string);
      metadata.deletedLines = count.lines;
      if (count.truncated) truncation.push({ field: 'deletedLines' });
    }
    if (typeof input.new_string === 'string') {
      const count = countClaudeLinesBounded(input.new_string);
      metadata.addedLines = count.lines;
      if (count.truncated) truncation.push({ field: 'addedLines' });
    }
    if (typeof input.replace_all === 'boolean') metadata.replaceAll = input.replace_all;
  }

  if (normalizedName.includes('write') || normalizedName === 'create_file') {
    addText('contentPreview', 'content', 2 * 1024);
    if (typeof input.content === 'string') {
      const count = countClaudeLinesBounded(input.content);
      metadata.totalLines = count.lines;
      if (count.truncated) truncation.push({ field: 'totalLines' });
    }
  }

  if (normalizedName.includes('read')) {
    if (typeof input.offset === 'number' && Number.isFinite(input.offset)) {
      metadata.offset = input.offset;
    }
    if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
      metadata.limit = input.limit;
    }
  }

  if (
    normalizedName === 'bash' ||
    normalizedName.includes('shell') ||
    normalizedName === 'run'
  ) {
    addText('command', 'command');
    addText('commandDescription', 'description');
  }

  if (normalizedName === 'grep' || normalizedName.includes('search')) {
    addText('pattern', 'pattern');
    addText('searchPath', 'path');
    addText('glob', 'glob');
    addText('outputMode', 'output_mode');
  }
  if (normalizedName === 'glob' || normalizedName === 'glob_files') {
    addText('pattern', 'pattern');
    addText('searchPath', 'path');
  }

  if (normalizedName === 'todo_write' || normalizedName === 'todowrite') {
    if (Array.isArray(input.todos)) {
      const todoSummary = buildBoundedTodoSummary(input.todos);
      metadata.todoCount = input.todos.length;
      metadata.todos = todoSummary.todos;
      if (todoSummary.truncated) truncation.push({ field: 'todos' });
    }
  }

  metadata.rawInput = buildBoundedRawInputSummary(input);
  if (truncation.length > 0) {
    metadata.truncated = true;
    metadata.truncation = truncation;
  }
  enforceToolMetadataJsonBudget(metadata);
  return metadata;
}

class BoundedTextBuilder {
  private readonly chunks: string[] = [];
  private bytes = 0;
  private didTruncate = false;

  public constructor(private readonly maximumBytes: number) {}

  public append(value: string, separator = ''): void {
    if (!value) return;
    const prefix = this.chunks.length > 0 ? separator : '';
    if (prefix) this.appendPart(prefix);
    this.appendPart(value);
  }

  public markTruncated(): void {
    this.didTruncate = true;
  }

  public finish(): { text: string; truncated: boolean } {
    let text = this.chunks.join('').trim();
    if (this.didTruncate && !text.endsWith('… [truncated]')) {
      text = boundClaudeEventText(`${text}${TRUNCATION_MARKER}`, this.maximumBytes).text;
    }
    return { text, truncated: this.didTruncate };
  }

  private appendPart(value: string): void {
    const remaining = this.maximumBytes - this.bytes;
    if (remaining <= TRUNCATION_MARKER_BYTES) {
      this.didTruncate = true;
      return;
    }
    const bounded = boundClaudeEventText(value, remaining);
    if (bounded.text) this.chunks.push(bounded.text);
    this.bytes += bounded.retainedBytes;
    if (bounded.truncated) this.didTruncate = true;
  }
}

export interface BoundedClaudeContent {
  content?: string;
  truncated: boolean;
}

function extractBoundedContentArray(
  content: unknown[],
  separator: string,
): BoundedClaudeContent {
  const builder = new BoundedTextBuilder(AGENT_MESSAGE_CONTENT_MAX_BYTES);
  const scanLimit = Math.min(content.length, CLAUDE_MESSAGE_CONTENT_MAX_ENTRIES);
  for (let index = 0; index < scanLimit; index += 1) {
    const part = content[index];
    if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') continue;
    builder.append(part.text, separator);
  }
  if (content.length > scanLimit) builder.markTruncated();
  const result = builder.finish();
  return { ...(result.text ? { content: result.text } : {}), truncated: result.truncated };
}

export function extractBoundedClaudeMessageContent(
  message: unknown,
  depth = 0,
): BoundedClaudeContent {
  if (depth > 3 || !isRecord(message)) return { truncated: false };

  if (typeof message.result === 'string') {
    const bounded = boundClaudeEventText(message.result, AGENT_MESSAGE_CONTENT_MAX_BYTES);
    return { content: bounded.text.trim(), truncated: bounded.truncated };
  }
  if (isRecord(message.message)) {
    const nested = extractBoundedClaudeMessageContent(message.message, depth + 1);
    if (nested.content) return nested;
  }
  if (typeof message.content === 'string') {
    const bounded = boundClaudeEventText(message.content, AGENT_MESSAGE_CONTENT_MAX_BYTES);
    return { content: bounded.text.trim(), truncated: bounded.truncated };
  }
  if (typeof message.text === 'string') {
    const bounded = boundClaudeEventText(message.text, AGENT_MESSAGE_CONTENT_MAX_BYTES);
    return { content: bounded.text.trim(), truncated: bounded.truncated };
  }
  if (Array.isArray(message.content)) {
    return extractBoundedContentArray(message.content, '');
  }
  return { truncated: false };
}

export function extractBoundedClaudeToolResultContent(
  block: Record<string, unknown>,
): BoundedClaudeContent {
  if (typeof block.content === 'string') {
    const bounded = boundClaudeEventText(block.content, AGENT_MESSAGE_CONTENT_MAX_BYTES);
    return { content: bounded.text, truncated: bounded.truncated };
  }
  if (Array.isArray(block.content)) {
    return extractBoundedContentArray(block.content, '\n');
  }
  return { truncated: false };
}

export function buildBoundedClaudeResultError(
  errors: unknown,
  resultText: unknown,
): string {
  if (Array.isArray(errors) && errors.length > 0) {
    const builder = new BoundedTextBuilder(CLAUDE_EVENT_ERROR_MAX_BYTES);
    const scanLimit = Math.min(errors.length, 32);
    for (let index = 0; index < scanLimit; index += 1) {
      const error = errors[index];
      if (typeof error === 'string') builder.append(error, '; ');
    }
    if (errors.length > scanLimit) builder.markTruncated();
    const result = builder.finish().text;
    if (result) return result;
  }
  if (typeof resultText === 'string') {
    return boundClaudeEventText(resultText, CLAUDE_EVENT_ERROR_MAX_BYTES).text;
  }
  return 'Unknown error from Claude Code';
}
