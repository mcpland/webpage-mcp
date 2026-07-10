export interface JsonResourceLimits {
  maxUtf8Bytes: number;
  maxStringUtf8Bytes: number;
  maxDepth: number;
  maxValues: number;
}

function addWithinLimit(
  current: number,
  amount: number,
  limit: number,
): number | null {
  if (amount > limit - current) return null;
  return current + amount;
}

/** Return the exact UTF-8 byte length used by JSON.stringify for a string value. */
function jsonStringUtf8Bytes(value: string, stopAfter: number): number {
  let bytes = 2; // Surrounding quotes.
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let nextBytes: number;

    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      nextBytes = 2;
    } else if (
      codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
    ) {
      nextBytes = 2;
    } else if (codeUnit <= 0x1f) {
      nextBytes = 6;
    } else if (codeUnit <= 0x7f) {
      nextBytes = 1;
    } else if (codeUnit <= 0x7ff) {
      nextBytes = 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        nextBytes = 4;
        index += 1;
      } else {
        nextBytes = 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      nextBytes = 6;
    } else {
      nextBytes = 3;
    }

    bytes += nextBytes;
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

/**
 * Validate JSON-compatible data without first materializing a second, potentially
 * huge serialized copy. The reported byte count matches JSON.stringify for the
 * supported primitives and plain objects/arrays.
 */
export function findJsonResourceLimitViolation(
  value: unknown,
  limits: JsonResourceLimits,
  rootPath = "value",
): string | null {
  const ancestors = new WeakSet<object>();
  let totalBytes = 0;
  let valueCount = 0;

  const addBytes = (amount: number): boolean => {
    const next = addWithinLimit(totalBytes, amount, limits.maxUtf8Bytes);
    if (next === null) return false;
    totalBytes = next;
    return true;
  };

  const visit = (
    currentValue: unknown,
    depth: number,
    path: string,
  ): string | null => {
    valueCount += 1;
    if (valueCount > limits.maxValues) {
      return `${rootPath} exceeds the ${limits.maxValues}-value JSON limit`;
    }
    if (depth > limits.maxDepth) {
      return `${path} exceeds the ${limits.maxDepth}-level JSON depth limit`;
    }

    if (currentValue === null) {
      if (!addBytes(4))
        return `${rootPath} exceeds the ${limits.maxUtf8Bytes}-byte JSON limit`;
      return null;
    }

    switch (typeof currentValue) {
      case "string": {
        const bytes = jsonStringUtf8Bytes(
          currentValue,
          limits.maxStringUtf8Bytes + 2,
        );
        if (bytes - 2 > limits.maxStringUtf8Bytes) {
          return `${path} exceeds the ${limits.maxStringUtf8Bytes}-byte string limit`;
        }
        if (!addBytes(bytes)) {
          return `${rootPath} exceeds the ${limits.maxUtf8Bytes}-byte JSON limit`;
        }
        return null;
      }
      case "boolean":
        if (!addBytes(currentValue ? 4 : 5)) {
          return `${rootPath} exceeds the ${limits.maxUtf8Bytes}-byte JSON limit`;
        }
        return null;
      case "number": {
        const serialized = Number.isFinite(currentValue)
          ? String(currentValue)
          : "null";
        if (!addBytes(serialized.length)) {
          return `${rootPath} exceeds the ${limits.maxUtf8Bytes}-byte JSON limit`;
        }
        return null;
      }
      case "object": {
        if (ancestors.has(currentValue))
          return `${path} must not contain circular references`;
        ancestors.add(currentValue);

        try {
          if (Array.isArray(currentValue)) {
            if (!addBytes(2)) {
              return `${rootPath} exceeds the ${limits.maxUtf8Bytes}-byte JSON limit`;
            }
            for (let index = 0; index < currentValue.length; index += 1) {
              if (index > 0 && !addBytes(1)) {
                return `${rootPath} exceeds the ${limits.maxUtf8Bytes}-byte JSON limit`;
              }
              const entryValue = currentValue[index];
              const normalizedValue =
                entryValue === undefined ||
                typeof entryValue === "function" ||
                typeof entryValue === "symbol"
                  ? null
                  : entryValue;
              const violation = visit(
                normalizedValue,
                depth + 1,
                `${path}[${index}]`,
              );
              if (violation) return violation;
            }
            return null;
          }

          const prototype = Object.getPrototypeOf(currentValue);
          if (prototype !== Object.prototype && prototype !== null) {
            return `${path} must contain only plain JSON objects`;
          }
          if (!addBytes(2)) {
            return `${rootPath} exceeds the ${limits.maxUtf8Bytes}-byte JSON limit`;
          }
          let propertyCount = 0;
          for (const key in currentValue) {
            if (!Object.prototype.hasOwnProperty.call(currentValue, key))
              continue;
            const entryValue = (currentValue as Record<string, unknown>)[key];
            if (
              entryValue === undefined ||
              typeof entryValue === "function" ||
              typeof entryValue === "symbol"
            ) {
              continue;
            }
            if (propertyCount > 0 && !addBytes(1)) {
              return `${rootPath} exceeds the ${limits.maxUtf8Bytes}-byte JSON limit`;
            }
            propertyCount += 1;
            const keyBytes = jsonStringUtf8Bytes(
              key,
              limits.maxStringUtf8Bytes + 2,
            );
            if (keyBytes - 2 > limits.maxStringUtf8Bytes) {
              return `${path} contains a key exceeding the ${limits.maxStringUtf8Bytes}-byte string limit`;
            }
            if (!addBytes(keyBytes + 1)) {
              return `${rootPath} exceeds the ${limits.maxUtf8Bytes}-byte JSON limit`;
            }
            const violation = visit(entryValue, depth + 1, `${path}.${key}`);
            if (violation) return violation;
          }
          return null;
        } finally {
          ancestors.delete(currentValue);
        }
      }
      default:
        return `${path} is not JSON-compatible`;
    }
  };

  return visit(value, 0, rootPath);
}
