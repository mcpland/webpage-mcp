import { DOM_TRIGGER_LIMITS } from "./dom-trigger-policy";
import { findJsonResourceLimitViolation } from "./json-limits";

export const TRIGGER_RESOURCE_LIMITS = Object.freeze({
  maxStoredTriggers: DOM_TRIGGER_LIMITS.maxStoredTriggers,
  maxTriggerUtf8Bytes: 64 * 1024,
  maxStringUtf8Bytes: 32 * 1024,
  maxJsonDepth: 32,
  maxJsonValues: 10_000,
  maxListUtf8Bytes: 17 * 1024 * 1024,
  maxIdentifierUtf8Bytes: 512,
  maxUrlMatchRules: 64,
  maxContextMenuContexts: 16,
});

export function findTriggerResourceLimitViolation(
  trigger: unknown,
): string | null {
  return findJsonResourceLimitViolation(
    trigger,
    {
      maxUtf8Bytes: TRIGGER_RESOURCE_LIMITS.maxTriggerUtf8Bytes,
      maxStringUtf8Bytes: TRIGGER_RESOURCE_LIMITS.maxStringUtf8Bytes,
      maxDepth: TRIGGER_RESOURCE_LIMITS.maxJsonDepth,
      maxValues: TRIGGER_RESOURCE_LIMITS.maxJsonValues,
    },
    "trigger",
  );
}

export function findTriggerIdentifierViolation(
  value: unknown,
  field: "trigger.id" | "trigger.flowId",
): string | null {
  if (typeof value !== "string" || !value.trim()) return `${field} is required`;
  return findJsonResourceLimitViolation(
    value,
    {
      maxUtf8Bytes: TRIGGER_RESOURCE_LIMITS.maxIdentifierUtf8Bytes + 2,
      maxStringUtf8Bytes: TRIGGER_RESOURCE_LIMITS.maxIdentifierUtf8Bytes,
      maxDepth: 1,
      maxValues: 1,
    },
    field,
  );
}
