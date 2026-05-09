import type { FlowExposedOutput, FlowV3 } from "../domain/flow";
import type { JsonObject, JsonValue } from "../domain/json";
import { containsSensitiveValue, isSensitiveKeyName } from "./sensitive";

const REDACTED = "[REDACTED]";

export interface WorkflowOutputValidationError {
  code: string;
  path: string;
  message: string;
  nodeId?: string;
  alias?: string;
}

export interface WorkflowOutputProjectionResult {
  ok: boolean;
  outputs: JsonObject;
  declaredOutputCount: number;
  redacted: string[];
  errors: WorkflowOutputValidationError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    default:
      return true;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`;
}

function validateAgainstSchema(
  schema: unknown,
  value: unknown,
  path: string,
): WorkflowOutputValidationError[] {
  if (!isRecord(schema)) {
    return [];
  }

  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (anyOf && anyOf.length > 0) {
    const anyValid = anyOf.some(
      (candidate) => validateAgainstSchema(candidate, value, path).length === 0,
    );
    return anyValid
      ? []
      : [
          {
            code: "OUTPUT_SCHEMA_ANY_OF_FAILED",
            path,
            message: "Output value did not match any allowed schema.",
          },
        ];
  }

  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (oneOf && oneOf.length > 0) {
    const matches = oneOf.filter(
      (candidate) => validateAgainstSchema(candidate, value, path).length === 0,
    ).length;
    return matches === 1
      ? []
      : [
          {
            code: "OUTPUT_SCHEMA_ONE_OF_FAILED",
            path,
            message: "Output value did not match exactly one allowed schema.",
          },
        ];
  }

  const allOf = Array.isArray(schema.allOf) ? schema.allOf : undefined;
  if (allOf && allOf.length > 0) {
    return allOf.flatMap((candidate) => validateAgainstSchema(candidate, value, path));
  }

  const errors: WorkflowOutputValidationError[] = [];
  const expectedTypes =
    typeof schema.type === "string"
      ? [schema.type]
      : Array.isArray(schema.type)
        ? schema.type.filter((item): item is string => typeof item === "string")
        : [];
  if (
    expectedTypes.length > 0 &&
    !expectedTypes.some((expectedType) => typeMatches(value, expectedType))
  ) {
    errors.push({
      code: "OUTPUT_SCHEMA_TYPE_MISMATCH",
      path,
      message: `Output value must be ${expectedTypes.join(" or ")}.`,
    });
    return errors;
  }

  if (Array.isArray(schema.enum)) {
    const actual = stableStringify(value);
    if (!schema.enum.some((entry) => stableStringify(entry) === actual)) {
      errors.push({
        code: "OUTPUT_SCHEMA_ENUM_MISMATCH",
        path,
        message: "Output value is not in the allowed enum set.",
      });
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(schema, "const") &&
    stableStringify(schema.const) !== stableStringify(value)
  ) {
    errors.push({
      code: "OUTPUT_SCHEMA_CONST_MISMATCH",
      path,
      message: "Output value does not match the required constant.",
    });
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push({
        code: "OUTPUT_SCHEMA_STRING_TOO_SHORT",
        path,
        message: `Output string is shorter than ${schema.minLength}.`,
      });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push({
        code: "OUTPUT_SCHEMA_STRING_TOO_LONG",
        path,
        message: `Output string is longer than ${schema.maxLength}.`,
      });
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push({
            code: "OUTPUT_SCHEMA_PATTERN_MISMATCH",
            path,
            message: "Output string does not match the required pattern.",
          });
        }
      } catch {
        errors.push({
          code: "OUTPUT_SCHEMA_INVALID_PATTERN",
          path,
          message: "Output schema pattern is not a valid regular expression.",
        });
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({
        code: "OUTPUT_SCHEMA_NUMBER_TOO_SMALL",
        path,
        message: `Output number is below ${schema.minimum}.`,
      });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({
        code: "OUTPUT_SCHEMA_NUMBER_TOO_LARGE",
        path,
        message: `Output number is above ${schema.maximum}.`,
      });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push({
        code: "OUTPUT_SCHEMA_ARRAY_TOO_SHORT",
        path,
        message: `Output array has fewer than ${schema.minItems} item(s).`,
      });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push({
        code: "OUTPUT_SCHEMA_ARRAY_TOO_LONG",
        path,
        message: `Output array has more than ${schema.maxItems} item(s).`,
      });
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateAgainstSchema(schema.items, item, `${path}/${index}`));
      });
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push({
          code: "OUTPUT_SCHEMA_REQUIRED_MISSING",
          path: `${path}/${key}`,
          message: `Required output property is missing: ${key}`,
        });
      }
    }
    for (const [key, nested] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(...validateAgainstSchema(properties[key], nested, `${path}/${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push({
          code: "OUTPUT_SCHEMA_ADDITIONAL_PROPERTY",
          path: `${path}/${key}`,
          message: `Output contains undeclared property: ${key}`,
        });
      } else if (isRecord(schema.additionalProperties)) {
        errors.push(
          ...validateAgainstSchema(schema.additionalProperties, nested, `${path}/${key}`),
        );
      }
    }
  }

  return errors;
}

function readOutputPath(root: unknown, path: ReadonlyArray<string | number> | undefined): unknown {
  let current = root;
  for (const segment of path ?? []) {
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
    } else if (isRecord(current) && typeof segment === "string") {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function shouldRedactOutput(output: FlowExposedOutput, value: JsonValue): boolean {
  if (output.allowPlaintext === true) {
    return false;
  }
  return (
    output.sensitive === true ||
    isSensitiveKeyName(output.as) ||
    containsSensitiveValue(value)
  );
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function projectAndValidateWorkflowOutputs(
  flow: FlowV3,
  rawOutputs: unknown,
): WorkflowOutputProjectionResult {
  const declared = Array.isArray(flow.meta?.exposedOutputs) ? flow.meta.exposedOutputs : [];
  if (declared.length === 0) {
    return {
      ok: true,
      outputs: {},
      declaredOutputCount: 0,
      redacted: [],
      errors: [],
    };
  }

  const outputRoot = isRecord(rawOutputs) ? rawOutputs : {};
  const hasNodeKey = declared.some((output) =>
    Object.prototype.hasOwnProperty.call(outputRoot, output.nodeId),
  );
  if (!hasNodeKey) {
    const aliasProjected: JsonObject = {};
    const errors: WorkflowOutputValidationError[] = [];
    const redacted: string[] = [];
    for (const declaration of declared) {
      const outputPath = `/outputs/${declaration.as}`;
      if (Object.prototype.hasOwnProperty.call(outputRoot, declaration.as)) {
        const jsonValue = toJsonValue(outputRoot[declaration.as]);
        const schemaErrors = validateAgainstSchema(declaration.schema ?? {}, jsonValue, outputPath);
        if (schemaErrors.length > 0) {
          errors.push(
            ...schemaErrors.map((error) => ({
              ...error,
              nodeId: declaration.nodeId,
              alias: declaration.as,
            })),
          );
          continue;
        }
        if (shouldRedactOutput(declaration, jsonValue)) {
          aliasProjected[declaration.as] = REDACTED;
          redacted.push(declaration.as);
        } else {
          aliasProjected[declaration.as] = jsonValue;
        }
      } else if (declaration.required !== false) {
        errors.push({
          code: "OUTPUT_MISSING",
          path: outputPath,
          message: `Required workflow output is missing: ${declaration.as}`,
          nodeId: declaration.nodeId,
          alias: declaration.as,
        });
      }
    }
    return {
      ok: errors.length === 0,
      outputs: aliasProjected,
      declaredOutputCount: declared.length,
      redacted,
      errors,
    };
  }

  const outputs: JsonObject = {};
  const errors: WorkflowOutputValidationError[] = [];
  const redacted: string[] = [];

  for (const declaration of declared) {
    const outputPath = `/outputs/${declaration.as}`;
    const nodeOutput = outputRoot[declaration.nodeId];
    const value = readOutputPath(nodeOutput, declaration.path);
    if (value === undefined) {
      if (declaration.required !== false) {
        errors.push({
          code: "OUTPUT_MISSING",
          path: outputPath,
          message: `Required workflow output is missing: ${declaration.as}`,
          nodeId: declaration.nodeId,
          alias: declaration.as,
        });
      }
      continue;
    }

    const jsonValue = toJsonValue(value);
    const schemaErrors = validateAgainstSchema(declaration.schema ?? {}, jsonValue, outputPath);
    if (schemaErrors.length > 0) {
      errors.push(
        ...schemaErrors.map((error) => ({
          ...error,
          nodeId: declaration.nodeId,
          alias: declaration.as,
        })),
      );
      continue;
    }

    if (shouldRedactOutput(declaration, jsonValue)) {
      outputs[declaration.as] = REDACTED;
      redacted.push(declaration.as);
    } else {
      outputs[declaration.as] = jsonValue;
    }
  }

  return {
    ok: errors.length === 0,
    outputs,
    declaredOutputCount: declared.length,
    redacted,
    errors,
  };
}
