import { describe, expect, it, vi } from "vitest";

import {
  type JavaScriptEvaluationHolder,
  serializeJavaScriptEvaluation,
} from "@/entrypoints/background/tools/browser/javascript-page-serializer";

function serialize(value: unknown, maxOutputBytes = 50 * 1024) {
  return serializeJavaScriptEvaluation.call(
    {
      __webpageMcpStatus: 1,
      __webpageMcpValue: value,
    } satisfies JavaScriptEvaluationHolder,
    maxOutputBytes,
  );
}

function serializeError(value: unknown, maxOutputBytes = 50 * 1024) {
  return serializeJavaScriptEvaluation.call(
    {
      __webpageMcpStatus: 0,
      __webpageMcpValue: value,
    } satisfies JavaScriptEvaluationHolder,
    maxOutputBytes,
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

describe("bounded JavaScript page serializer", () => {
  it("preserves normal return formatting while redacting sensitive fields and text", () => {
    const result = serialize({
      title: "hello",
      count: 3,
      password: "do-not-return",
      nested: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" },
      note: "Bearer abcdefghijklmnopqrstuvwxyz",
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(JSON.parse(result.text)).toEqual({
      title: "hello",
      count: 3,
      password: "<redacted>",
      nested: { authorization: "<redacted>" },
      note: "Bearer <redacted>",
    });
    expect(result.redacted).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("redacts sensitive properties without invoking their getters", () => {
    let reads = 0;
    const value = Object.defineProperty({}, "accessToken", {
      enumerable: true,
      get() {
        reads += 1;
        return "must-not-be-read";
      },
    });

    const result = serialize(value);

    expect(reads).toBe(0);
    expect(result).toMatchObject({
      status: "success",
      text: '{"accessToken":"<redacted>"}',
      redacted: true,
    });
  });

  it("preserves cookie, JWT, assignment, and encoded-secret sanitization", () => {
    const jwt = `${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;
    const result = serialize({
      first: "first=one; second=two",
      second: `value ${jwt}`,
      third: "password=do-not-return",
      fourth: "A".repeat(24),
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(JSON.parse(result.text)).toEqual({
      first: "[BLOCKED: Cookie/query string data]",
      second: "value <redacted_jwt>",
      third: "password=<redacted>",
      fourth: "[BLOCKED: Base64 encoded data]",
    });
    expect(result.redacted).toBe(true);
  });

  it("bounds huge root strings in the page before they can cross CDP", () => {
    const result = serialize("*".repeat(5_000_000), 1024);

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(1024);
    expect(result.text).toContain("truncated");
    expect(result.truncated).toBe(true);
  });

  it("enforces depth limits without recursively walking a malicious deep graph", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let index = 0; index < 20_000; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    const result = serialize(root);

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.text).toContain("[MaxDepth]");
    expect(result.truncated).toBe(true);
  });

  it("reads at most the bounded array width even when length is enormous", () => {
    let numericReads = 0;
    const value = new Proxy([], {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          numericReads += 1;
        }
        if (property === "length") return 2 ** 32 - 1;
        return Reflect.get(target, property, receiver);
      },
    });

    const result = serialize(value, 100_000);

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(numericReads).toBe(200);
    expect(result.text).toContain("[...truncated]");
    expect(result.truncated).toBe(true);
  });

  it("reads no more than the bounded object width and does not enumerate via Object.keys", () => {
    let valueReads = 0;
    const target: Record<string, unknown> = {};
    for (let index = 0; index < 10_000; index += 1) {
      Object.defineProperty(target, `key${index}`, {
        enumerable: true,
        get() {
          valueReads += 1;
          return index;
        },
      });
    }

    const result = serialize(target, 100_000);

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(valueReads).toBe(200);
    expect(result.text).toContain('"__truncated__":true');
    expect(result.truncated).toBe(true);
  });

  it("enforces a global visited-value budget across a broad nested graph", () => {
    const value = Array.from({ length: 100 }, () =>
      Array.from({ length: 100 }, () => 0),
    );

    const result = serialize(value, 1024 * 1024);

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.text).toContain("[NodeLimit]");
    expect(result.truncated).toBe(true);
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(1024 * 1024);
  });

  it("fails closed on hostile property enumeration and getter traps", () => {
    const enumerationFailure = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("do not leak this secret");
        },
      },
    );
    const getterFailure = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        throw new Error("do not leak this secret");
      },
    });

    const enumerationResult = serialize(enumerationFailure);
    const getterResult = serialize(getterFailure);

    expect(enumerationResult.status).toBe("success");
    expect(getterResult.status).toBe("success");
    if (
      enumerationResult.status !== "success" ||
      getterResult.status !== "success"
    ) {
      return;
    }
    expect(enumerationResult.text).toBe('{"__serialization_error__":true}');
    expect(getterResult.text).toBe('{"value":"[Property access threw]"}');
    expect(enumerationResult.text).not.toContain("secret");
    expect(getterResult.text).not.toContain("secret");
  });

  it("does not trust prototype join, slice, or replace results for its final envelope", () => {
    const huge = "x".repeat(5_000_000);
    const join = vi.spyOn(Array.prototype, "join").mockReturnValue(huge);
    const slice = vi.spyOn(String.prototype, "slice").mockReturnValue(huge);
    const replace = vi.spyOn(String.prototype, "replace").mockReturnValue(huge);
    let result: ReturnType<typeof serialize>;
    try {
      result = serialize("ordinary text", 128);
    } finally {
      replace.mockRestore();
      slice.mockRestore();
      join.mockRestore();
    }

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.text).toBe("ordinary text");
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(128);
  });

  it("does not invoke a poisoned String.replace while sanitizing", () => {
    const replace = vi
      .spyOn(String.prototype, "replace")
      .mockImplementation(() => {
        throw new Error("x".repeat(1_000_000));
      });
    let result: ReturnType<typeof serialize>;
    try {
      result = serialize("Bearer abcdefghijklmnopqrstuvwxyz", 128);
    } finally {
      replace.mockRestore();
    }

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.text).toBe("Bearer <redacted>");
    expect(result.redacted).toBe(true);
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(128);
  });

  it("handles circular, bigint, sparse, and invalid Unicode values safely", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const sparse: unknown[] = new Array(3);
    sparse[0] = undefined;
    sparse[2] = 3;
    const result = serialize({
      circular,
      bigint: 123n,
      sparse,
      unicode: "\ud800",
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(JSON.parse(result.text)).toEqual({
      circular: { self: "[Circular]" },
      bigint: "123n",
      sparse: [null, null, 3],
      unicode: "\ud800",
    });
  });

  it("serializes shared references independently without reporting a cycle", () => {
    const shared = { nested: { value: 1 } };
    const result = serialize({ first: shared, second: shared });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(JSON.parse(result.text)).toEqual({
      first: { nested: { value: 1 } },
      second: { nested: { value: 1 } },
    });
    expect(result.text).not.toContain("[Circular]");
    expect(result.truncated).toBe(false);
  });

  it("preserves bounded hints for built-in objects with no enumerable fields", () => {
    const result = serialize({
      date: new Date("2026-07-22T01:02:03.000Z"),
      regexp: /hello\s+world/giu,
      map: new Map([
        ["first", 1],
        ["second", 2],
      ]),
      set: new Set([1, 2, 3]),
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(JSON.parse(result.text)).toEqual({
      date: "[Date: 2026-07-22T01:02:03.000Z]",
      regexp: "[RegExp: /hello\\s+world/giu]",
      map: "[Map(2)]",
      set: "[Set(3)]",
    });
    expect(result.truncated).toBe(false);
  });

  it("bounds and sanitizes huge thrown values", () => {
    const error = new Error("Bearer super-secret-token");
    error.stack = `Error: Bearer super-secret-token\n${"x".repeat(2_000_000)}`;

    const result = serializeError(error, 512);

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(utf8Bytes(result.message)).toBeLessThanOrEqual(512);
    expect(result.message).not.toContain("super-secret-token");
    expect(result.message).toContain("<redacted>");
  });

  it("classifies caught SyntaxError values without exposing oversized messages", () => {
    const error = new SyntaxError(`bad token ${"z".repeat(100_000)}`);
    const result = serializeError(error, 256);

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.errorKind).toBe("syntax_error");
    expect(utf8Bytes(result.message)).toBeLessThanOrEqual(256);
  });
});
