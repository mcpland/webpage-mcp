import type { Step, TargetLocator, VariableDef } from '../types';

const MAX_ID_LENGTH = 256;
const MAX_STRING_LENGTH = 16_384;
const MAX_VALUE_LENGTH = 1_048_576;
const MAX_CANDIDATES = 32;
const MAX_PATH_LENGTH = 128;
const MAX_TIMEOUT_MS = 120_000;

const RECORDER_STEP_TYPES = new Set(['click', 'dblclick', 'fill', 'key', 'scroll', 'wait']);
const SELECTOR_TYPES = new Set(['css', 'xpath', 'attr', 'aria', 'text']);
const SELECTOR_SOURCES = new Set(['recorded', 'user', 'generated']);

export type RecorderValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boundedString(
  value: unknown,
  field: string,
  options: { required?: boolean; max?: number } = {},
): RecorderValidationResult<string | undefined> {
  if (value === undefined) {
    return options.required
      ? { ok: false, error: `${field} is required` }
      : { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: `${field} must be a string` };
  }
  if (options.required && value.trim().length === 0) {
    return { ok: false, error: `${field} must not be empty` };
  }
  if (value.length > (options.max ?? MAX_STRING_LENGTH)) {
    return { ok: false, error: `${field} is too long` };
  }
  return { ok: true, value };
}

function sanitizeCandidate(
  input: unknown,
  index: number,
): RecorderValidationResult<TargetLocator['candidates'][number]> {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: `target.candidates[${index}] must be an object`,
    };
  }
  if (typeof input.type !== 'string' || !SELECTOR_TYPES.has(input.type)) {
    return {
      ok: false,
      error: `target.candidates[${index}].type is not allowed`,
    };
  }
  const value = boundedString(input.value, `target.candidates[${index}].value`, {
    required: true,
  });
  if (!value.ok) return value;

  const candidate: TargetLocator['candidates'][number] = {
    type: input.type as TargetLocator['candidates'][number]['type'],
    value: value.value!,
  };
  const weight = finiteNumber(input.weight);
  if (weight !== undefined) candidate.weight = weight;
  if (typeof input.source === 'string' && SELECTOR_SOURCES.has(input.source)) {
    candidate.source = input.source as NonNullable<typeof candidate.source>;
  }
  if (typeof input.strategy === 'string' && input.strategy.length <= MAX_STRING_LENGTH) {
    candidate.strategy = input.strategy;
  }
  const stability = finiteNumber(input.stability);
  if (stability !== undefined) candidate.stability = stability;
  return { ok: true, value: candidate };
}

export function sanitizeRecorderTarget(input: unknown): RecorderValidationResult<TargetLocator> {
  if (!isRecord(input)) {
    return { ok: false, error: 'target must be an object' };
  }
  if (!Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES) {
    return {
      ok: false,
      error: `target.candidates must be an array with at most ${MAX_CANDIDATES} entries`,
    };
  }

  const candidates: TargetLocator['candidates'] = [];
  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = sanitizeCandidate(input.candidates[index], index);
    if (!candidate.ok) return candidate;
    candidates.push(candidate.value);
  }

  const target: TargetLocator = { candidates };
  for (const field of ['ref', 'selector', 'tag', 'fingerprint'] as const) {
    const result = boundedString(input[field], `target.${field}`);
    if (!result.ok) return result;
    if (result.value !== undefined) target[field] = result.value;
  }

  if (input.domPath !== undefined) {
    if (
      !Array.isArray(input.domPath) ||
      input.domPath.length > MAX_PATH_LENGTH ||
      !input.domPath.every((item) => Number.isInteger(item) && Number(item) >= 0)
    ) {
      return {
        ok: false,
        error: 'target.domPath must contain non-negative integers',
      };
    }
    target.domPath = [...input.domPath] as number[];
  }

  if (input.shadowHostChain !== undefined) {
    if (!Array.isArray(input.shadowHostChain) || input.shadowHostChain.length > MAX_PATH_LENGTH) {
      return {
        ok: false,
        error: 'target.shadowHostChain must be a bounded string array',
      };
    }
    const shadowHostChain: string[] = [];
    for (let index = 0; index < input.shadowHostChain.length; index += 1) {
      const item = boundedString(input.shadowHostChain[index], `target.shadowHostChain[${index}]`, {
        required: true,
      });
      if (!item.ok) return item;
      shadowHostChain.push(item.value!);
    }
    target.shadowHostChain = shadowHostChain;
  }

  if (!target.ref && !target.selector && target.candidates.length === 0) {
    return { ok: false, error: 'target requires a ref, selector, or selector candidate' };
  }

  // frameContext is deliberately not accepted from recorder payloads. The background
  // constructs it only after joining a frame-authenticated step with top-frame metadata.
  return { ok: true, value: target };
}

function sanitizeCommonFields(
  input: Record<string, unknown>,
  type: string,
): RecorderValidationResult<Record<string, unknown>> {
  const id = boundedString(input.id, 'step.id', {
    required: true,
    max: MAX_ID_LENGTH,
  });
  if (!id.ok) return id;

  const output: Record<string, unknown> = { id: id.value!, type };
  if (input.timeoutMs !== undefined) {
    const timeoutMs = finiteNumber(input.timeoutMs);
    if (timeoutMs === undefined || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
      return {
        ok: false,
        error: `step.timeoutMs must be between 0 and ${MAX_TIMEOUT_MS}`,
      };
    }
    output.timeoutMs = timeoutMs;
  }
  if (typeof input.screenshotOnFail === 'boolean') {
    output.screenshotOnFail = input.screenshotOnFail;
  }
  return { ok: true, value: output };
}

function sanitizeTargetField(
  input: Record<string, unknown>,
  field: 'target',
  required = true,
): RecorderValidationResult<TargetLocator | undefined> {
  if (input[field] === undefined && !required) return { ok: true, value: undefined };
  return sanitizeRecorderTarget(input[field]);
}

export function sanitizeRecorderStep(input: unknown): RecorderValidationResult<Step> {
  if (!isRecord(input)) return { ok: false, error: 'step must be an object' };
  if (typeof input.type !== 'string' || !RECORDER_STEP_TYPES.has(input.type)) {
    return {
      ok: false,
      error: `recorder step type is not allowed: ${String(input.type)}`,
    };
  }

  const common = sanitizeCommonFields(input, input.type);
  if (!common.ok) return common as RecorderValidationResult<Step>;
  const output = common.value;

  if (input.type === 'click' || input.type === 'dblclick') {
    const target = sanitizeTargetField(input, 'target');
    if (!target.ok) return target as RecorderValidationResult<Step>;
    output.target = target.value;

    if (isRecord(input.before)) {
      const before: Record<string, boolean> = {};
      if (typeof input.before.scrollIntoView === 'boolean') {
        before.scrollIntoView = input.before.scrollIntoView;
      }
      if (typeof input.before.waitForSelector === 'boolean') {
        before.waitForSelector = input.before.waitForSelector;
      }
      if (Object.keys(before).length > 0) output.before = before;
    }
    if (isRecord(input.after)) {
      const after: Record<string, boolean> = {};
      if (typeof input.after.waitForNavigation === 'boolean') {
        after.waitForNavigation = input.after.waitForNavigation;
      }
      if (typeof input.after.waitForNetworkIdle === 'boolean') {
        after.waitForNetworkIdle = input.after.waitForNetworkIdle;
      }
      if (Object.keys(after).length > 0) output.after = after;
    }
  } else if (input.type === 'fill') {
    const target = sanitizeTargetField(input, 'target');
    if (!target.ok) return target as RecorderValidationResult<Step>;
    if (
      typeof input.value !== 'string' &&
      typeof input.value !== 'boolean' &&
      typeof input.value !== 'number'
    ) {
      return {
        ok: false,
        error: 'fill.value must be a string, boolean, or number',
      };
    }
    if (typeof input.value === 'number' && !Number.isFinite(input.value)) {
      return { ok: false, error: 'fill.value number must be finite' };
    }
    if (typeof input.value === 'string' && input.value.length > MAX_VALUE_LENGTH) {
      return { ok: false, error: 'fill.value is too long' };
    }
    output.target = target.value;
    output.value = input.value;
  } else if (input.type === 'key') {
    const keys = boundedString(input.keys, 'key.keys', {
      required: true,
      max: 512,
    });
    if (!keys.ok) return keys as RecorderValidationResult<Step>;
    const target = sanitizeTargetField(input, 'target', false);
    if (!target.ok) return target as RecorderValidationResult<Step>;
    output.keys = keys.value;
    if (target.value) output.target = target.value;
  } else if (input.type === 'scroll') {
    if (input.mode !== 'offset' && input.mode !== 'container') {
      return { ok: false, error: 'scroll.mode must be offset or container' };
    }
    output.mode = input.mode;
    if (input.mode === 'container') {
      const target = sanitizeTargetField(input, 'target');
      if (!target.ok) return target as RecorderValidationResult<Step>;
      output.target = target.value;
    }
    if (!isRecord(input.offset)) {
      return { ok: false, error: 'scroll.offset must be an object' };
    }
    const x = finiteNumber(input.offset.x);
    const y = finiteNumber(input.offset.y);
    if (x === undefined && y === undefined) {
      return {
        ok: false,
        error: 'scroll.offset requires a finite x or y value',
      };
    }
    output.offset = {
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
    };
  } else if (input.type === 'wait') {
    if (!isRecord(input.condition)) {
      return { ok: false, error: 'wait.condition must be an object' };
    }
    if (input.condition.networkIdle === true) {
      output.condition = { networkIdle: true };
    } else {
      const selector = boundedString(input.condition.selector, 'wait.condition.selector', {
        required: true,
      });
      if (!selector.ok) return selector as RecorderValidationResult<Step>;
      if (typeof input.condition.visible !== 'boolean') {
        return { ok: false, error: 'wait.condition.visible must be a boolean' };
      }
      output.condition = {
        selector: selector.value!,
        visible: input.condition.visible,
      };
    }
  }

  return { ok: true, value: output as unknown as Step };
}

export function sanitizeRecorderSteps(input: unknown): RecorderValidationResult<Step[]> {
  if (!Array.isArray(input) || input.length > 500) {
    return {
      ok: false,
      error: 'steps must be an array with at most 500 entries',
    };
  }
  const steps: Step[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const step = sanitizeRecorderStep(input[index]);
    if (!step.ok) return { ok: false, error: `steps[${index}]: ${step.error}` };
    steps.push(step.value);
  }
  return { ok: true, value: steps };
}

export function sanitizeRecorderVariables(input: unknown): RecorderValidationResult<VariableDef[]> {
  if (!Array.isArray(input) || input.length > 500) {
    return {
      ok: false,
      error: 'variables must be an array with at most 500 entries',
    };
  }
  const variables: VariableDef[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!isRecord(item)) return { ok: false, error: `variables[${index}] must be an object` };
    const key = boundedString(item.key, `variables[${index}].key`, {
      required: true,
      max: MAX_ID_LENGTH,
    });
    if (!key.ok) return key as RecorderValidationResult<VariableDef[]>;
    if (item.sensitive !== undefined && typeof item.sensitive !== 'boolean') {
      return {
        ok: false,
        error: `variables[${index}].sensitive must be a boolean`,
      };
    }
    if (item.default !== undefined && typeof item.default !== 'string') {
      return {
        ok: false,
        error: `variables[${index}].default must be a string`,
      };
    }
    if (typeof item.default === 'string' && item.default.length > MAX_VALUE_LENGTH) {
      return { ok: false, error: `variables[${index}].default is too long` };
    }
    variables.push({
      key: key.value!,
      ...(typeof item.sensitive === 'boolean' ? { sensitive: item.sensitive } : {}),
      ...(typeof item.default === 'string' ? { default: item.default } : {}),
    });
  }
  return { ok: true, value: variables };
}
