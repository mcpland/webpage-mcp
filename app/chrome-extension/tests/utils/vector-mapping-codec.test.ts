import { describe, expect, it } from "vitest";

import type { VectorDatabaseConfig } from "@/utils/vector-database";
import {
  VECTOR_MAPPING_SCHEMA_VERSION,
  parsePersistedVectorMappings,
} from "@/utils/vector-mapping-codec";

const config: VectorDatabaseConfig = {
  dimension: 3,
  maxElements: 10,
  efConstruction: 100,
  M: 16,
  efSearch: 50,
  indexFileName: "codec-test.dat",
};

function validMapping() {
  return {
    schemaVersion: VECTOR_MAPPING_SCHEMA_VERSION,
    revision: 4,
    updatedAt: 1234,
    dimension: config.dimension,
    indexFileName: config.indexFileName,
    documents: [
      [
        7,
        {
          id: "document-7",
          tabId: 42,
          url: "https://example.test/article",
          title: "Article",
          chunk: {
            text: "bounded text",
            source: "content",
            index: 0,
            wordCount: 2,
          },
          embedding: { 0: 1, 1: 0.5, 2: 0 },
          timestamp: 1000,
        },
      ],
    ],
    tabDocuments: [[42, [7]]],
    completedTabPages: [
      [
        42,
        {
          pageKey: "https://example.test/article\u0000Article",
          url: "https://example.test/article",
          title: "Article",
          labels: [7],
          expectedCount: 1,
        },
      ],
    ],
    nextLabel: 8,
  };
}

describe("persisted vector mapping codec", () => {
  it("rehydrates a structurally cloned embedding and exact completed page", () => {
    const parsed = parsePersistedVectorMappings(validMapping(), config);

    expect(parsed.status).toBe("found");
    if (parsed.status !== "found") return;
    expect(parsed.value.documents[0]?.[1].embedding).toEqual(
      new Float32Array([1, 0.5, 0]),
    );
    expect(parsed.value.completedTabPages).toEqual([
      [
        42,
        expect.objectContaining({
          pageKey: "https://example.test/article\u0000Article",
          labels: [7],
          expectedCount: 1,
        }),
      ],
    ]);
  });

  it("rejects page identities forged independently of their documents", () => {
    const mapping = validMapping();
    const completion = mapping.completedTabPages[0]?.[1];
    if (typeof completion !== "object") {
      throw new TypeError("test fixture completion is missing");
    }
    completion.pageKey = "https://attacker.test/article\u0000Article";

    expect(parsePersistedVectorMappings(mapping, config)).toEqual({
      status: "invalid",
      reason: "completed page data is invalid",
    });
  });

  it("rejects a next label that could overwrite a persisted document", () => {
    const mapping = validMapping();
    mapping.nextLabel = 7;

    expect(parsePersistedVectorMappings(mapping, config)).toEqual({
      status: "invalid",
      reason: "next vector label is inconsistent",
    });
  });
});
