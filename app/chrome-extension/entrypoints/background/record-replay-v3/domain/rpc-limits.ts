import {
  findJsonResourceLimitViolation,
  jsonUtf8ByteLength,
} from "./json-limits";

export const RR_V3_RPC_LIMITS = Object.freeze({
  maxRequestIdUtf8Bytes: 256,
  maxMethodUtf8Bytes: 128,
  maxParamsUtf8Bytes: 9 * 1024 * 1024,
  maxParamStringUtf8Bytes: 256 * 1024,
  maxParamsDepth: 64,
  maxParamsValues: 200_000,
  maxIdentifierUtf8Bytes: 512,
  defaultEventListLimit: 100,
  maxConnections: 16,
  maxSubscriptionsPerConnection: 64,
  maxInFlightPerConnection: 8,
});

function plainStringUtf8Bytes(value: string, maxBytes: number): number {
  return Math.max(0, jsonUtf8ByteLength(value, maxBytes + 2) - 2);
}

export function findRpcRequestEnvelopeViolation(value: {
  requestId?: unknown;
  method?: unknown;
  params?: unknown;
}): string | null {
  if (typeof value.requestId !== "string" || !value.requestId) {
    return "requestId must be a non-empty string";
  }
  if (
    plainStringUtf8Bytes(
      value.requestId,
      RR_V3_RPC_LIMITS.maxRequestIdUtf8Bytes,
    ) > RR_V3_RPC_LIMITS.maxRequestIdUtf8Bytes
  ) {
    return `requestId exceeds ${RR_V3_RPC_LIMITS.maxRequestIdUtf8Bytes} UTF-8 bytes`;
  }
  if (typeof value.method !== "string" || !value.method) {
    return "method must be a non-empty string";
  }
  if (
    plainStringUtf8Bytes(value.method, RR_V3_RPC_LIMITS.maxMethodUtf8Bytes) >
    RR_V3_RPC_LIMITS.maxMethodUtf8Bytes
  ) {
    return `method exceeds ${RR_V3_RPC_LIMITS.maxMethodUtf8Bytes} UTF-8 bytes`;
  }
  if (value.params !== undefined) {
    return findJsonResourceLimitViolation(
      value.params,
      {
        maxUtf8Bytes: RR_V3_RPC_LIMITS.maxParamsUtf8Bytes,
        maxStringUtf8Bytes: RR_V3_RPC_LIMITS.maxParamStringUtf8Bytes,
        maxDepth: RR_V3_RPC_LIMITS.maxParamsDepth,
        maxValues: RR_V3_RPC_LIMITS.maxParamsValues,
      },
      "params",
    );
  }
  return null;
}

export function isBoundedRpcIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    plainStringUtf8Bytes(value, RR_V3_RPC_LIMITS.maxIdentifierUtf8Bytes) <=
      RR_V3_RPC_LIMITS.maxIdentifierUtf8Bytes
  );
}

export function safeRpcResponseRequestId(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return plainStringUtf8Bytes(value, RR_V3_RPC_LIMITS.maxRequestIdUtf8Bytes) <=
    RR_V3_RPC_LIMITS.maxRequestIdUtf8Bytes
    ? value
    : "";
}
