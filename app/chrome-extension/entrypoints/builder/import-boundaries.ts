import { FLOW_RESOURCE_LIMITS } from '@/entrypoints/background/record-replay-v3/domain/flow-limits';
import { findJsonResourceLimitViolation } from '@/entrypoints/background/record-replay-v3/domain/json-limits';
import { extractFlowCandidates } from '@/entrypoints/shared/utils';

export const BUILDER_IMPORT_LIMITS = Object.freeze({
  maxFileBytes: FLOW_RESOURCE_LIMITS.maxFlowUtf8Bytes,
  maxCandidates: FLOW_RESOURCE_LIMITS.maxStoredFlows,
  maxNodes: FLOW_RESOURCE_LIMITS.maxNodes,
  maxEdges: FLOW_RESOURCE_LIMITS.maxEdges,
  maxSteps: FLOW_RESOURCE_LIMITS.maxNodes,
  maxSubflows: FLOW_RESOURCE_LIMITS.maxVariables,
  maxJsonDepth: FLOW_RESOURCE_LIMITS.maxJsonDepth,
  maxJsonValues: FLOW_RESOURCE_LIMITS.maxJsonValues,
  maxJsonTokens: FLOW_RESOURCE_LIMITS.maxJsonValues * 2 + 1,
  maxStringUtf8Bytes: FLOW_RESOURCE_LIMITS.maxStringUtf8Bytes,
});

interface ImportFile {
  size: number;
  text(): Promise<string>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonTextPreflight(text: string): void {
  let depth = 0;
  let tokens = 0;
  let inString = false;
  let escaped = false;
  let inScalar = false;

  const addToken = (): void => {
    tokens += 1;
    if (tokens > BUILDER_IMPORT_LIMITS.maxJsonTokens) {
      throw new Error(
        `Import JSON exceeds the ${BUILDER_IMPORT_LIMITS.maxJsonValues}-value limit`,
      );
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      inScalar = false;
      addToken();
      continue;
    }
    if (character === '{' || character === '[') {
      inScalar = false;
      depth += 1;
      if (depth > BUILDER_IMPORT_LIMITS.maxJsonDepth) {
        throw new Error(
          `Import JSON exceeds the ${BUILDER_IMPORT_LIMITS.maxJsonDepth}-level depth limit`,
        );
      }
      addToken();
      continue;
    }
    if (character === '}' || character === ']') {
      inScalar = false;
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (
      character === ',' ||
      character === ':' ||
      character === ' ' ||
      character === '\t' ||
      character === '\r' ||
      character === '\n'
    ) {
      inScalar = false;
      continue;
    }
    if (!inScalar) {
      inScalar = true;
      addToken();
    }
  }
}

function readBoundedArrayLength(
  record: Record<string, unknown>,
  field: string,
  limit: number,
  path: string,
): number {
  const value = record[field];
  if (value === undefined) return 0;
  if (!Array.isArray(value)) throw new Error(`${path}.${field} must be an array`);
  if (value.length > limit) {
    throw new Error(`${path}.${field} exceeds the ${limit}-item limit`);
  }
  return value.length;
}

function addWithinLimit(current: number, amount: number, limit: number, label: string): number {
  if (amount > limit - current) throw new Error(`${label} exceeds the ${limit}-item limit`);
  return current + amount;
}

function assertCandidateGraphBudget(candidate: unknown, candidateIndex: number): void {
  if (!isPlainRecord(candidate)) {
    throw new Error(`Import candidate ${candidateIndex + 1} must be a plain object`);
  }

  const path = `candidates[${candidateIndex}]`;
  const mainNodes = readBoundedArrayLength(
    candidate,
    'nodes',
    BUILDER_IMPORT_LIMITS.maxNodes,
    path,
  );
  const steps = readBoundedArrayLength(
    candidate,
    'steps',
    BUILDER_IMPORT_LIMITS.maxSteps,
    path,
  );
  let totalNodes = Math.max(mainNodes, steps);
  let totalEdges = readBoundedArrayLength(
    candidate,
    'edges',
    BUILDER_IMPORT_LIMITS.maxEdges,
    path,
  );

  const subflows = candidate.subflows;
  if (subflows === undefined) return;
  if (!isPlainRecord(subflows)) throw new Error(`${path}.subflows must be a plain object`);

  let subflowCount = 0;
  for (const subflowId in subflows) {
    if (!Object.prototype.hasOwnProperty.call(subflows, subflowId)) continue;
    subflowCount += 1;
    if (subflowCount > BUILDER_IMPORT_LIMITS.maxSubflows) {
      throw new Error(`${path}.subflows exceeds the ${BUILDER_IMPORT_LIMITS.maxSubflows}-item limit`);
    }
    const subflow = subflows[subflowId];
    if (!isPlainRecord(subflow)) {
      throw new Error(`${path}.subflows.${subflowId} must be a plain object`);
    }
    const subflowPath = `${path}.subflows.${subflowId}`;
    totalNodes = addWithinLimit(
      totalNodes,
      readBoundedArrayLength(
        subflow,
        'nodes',
        BUILDER_IMPORT_LIMITS.maxNodes,
        subflowPath,
      ),
      BUILDER_IMPORT_LIMITS.maxNodes,
      `${path} total nodes`,
    );
    totalEdges = addWithinLimit(
      totalEdges,
      readBoundedArrayLength(
        subflow,
        'edges',
        BUILDER_IMPORT_LIMITS.maxEdges,
        subflowPath,
      ),
      BUILDER_IMPORT_LIMITS.maxEdges,
      `${path} total edges`,
    );
  }
}

export async function readBuilderImportCandidates(file: ImportFile): Promise<unknown[]> {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > BUILDER_IMPORT_LIMITS.maxFileBytes
  ) {
    throw new Error(
      `Import file exceeds the ${BUILDER_IMPORT_LIMITS.maxFileBytes}-byte limit`,
    );
  }

  const text = await file.text();
  if (text.length > BUILDER_IMPORT_LIMITS.maxFileBytes) {
    throw new Error(
      `Import file exceeds the ${BUILDER_IMPORT_LIMITS.maxFileBytes}-byte limit`,
    );
  }
  assertJsonTextPreflight(text);

  const parsed: unknown = JSON.parse(text);
  const candidates = extractFlowCandidates(parsed);
  if (candidates.length > BUILDER_IMPORT_LIMITS.maxCandidates) {
    throw new Error(
      `Import exceeds the ${BUILDER_IMPORT_LIMITS.maxCandidates}-candidate limit`,
    );
  }
  for (let index = 0; index < candidates.length; index += 1) {
    assertCandidateGraphBudget(candidates[index], index);
  }

  const jsonViolation = findJsonResourceLimitViolation(
    parsed,
    {
      maxUtf8Bytes: BUILDER_IMPORT_LIMITS.maxFileBytes,
      maxStringUtf8Bytes: BUILDER_IMPORT_LIMITS.maxStringUtf8Bytes,
      maxDepth: BUILDER_IMPORT_LIMITS.maxJsonDepth,
      maxValues: BUILDER_IMPORT_LIMITS.maxJsonValues,
    },
    'import',
  );
  if (jsonViolation) throw new Error(jsonViolation);
  return candidates;
}
