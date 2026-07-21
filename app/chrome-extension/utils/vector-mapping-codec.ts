import type { VectorDatabaseConfig, VectorDocument } from "./vector-database";

export const VECTOR_MAPPING_SCHEMA_VERSION = 2;
export const MAX_HNSW_LABEL = 0xffffffff;

export interface PersistedTabPageCompletion {
  pageKey: string;
  url: string;
  title: string;
  labels: number[];
  expectedCount: number;
}

export interface PersistedVectorMappings {
  schemaVersion: number;
  revision: number;
  updatedAt: number;
  dimension: number;
  indexFileName: string;
  documents: Array<[number, VectorDocument]>;
  tabDocuments: Array<[number, number[]]>;
  completedTabPages: Array<[number, PersistedTabPageCompletion]>;
  nextLabel: number;
}

export type PersistedVectorMappingsLookup =
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "found"; value: PersistedVectorMappings };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parsePersistedEmbedding(
  value: unknown,
  dimension: number,
): Float32Array | null {
  let values: number[];
  if (value instanceof Float32Array) {
    values = Array.from(value);
  } else if (Array.isArray(value)) {
    values = value;
  } else if (isRecord(value)) {
    const keys = Object.keys(value);
    if (
      keys.length !== dimension ||
      keys.some((key, index) => key !== String(index))
    ) {
      return null;
    }
    values = keys.map((key) => value[key] as number);
  } else {
    return null;
  }

  if (
    values.length !== dimension ||
    values.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    return null;
  }
  return new Float32Array(values);
}

export function parsePersistedVectorMappings(
  value: unknown,
  config: VectorDatabaseConfig,
): PersistedVectorMappingsLookup {
  if (!isRecord(value)) {
    return { status: "invalid", reason: "mapping payload is not an object" };
  }
  if (value.schemaVersion !== VECTOR_MAPPING_SCHEMA_VERSION) {
    return {
      status: "invalid",
      reason: "mapping schema version is missing or unsupported",
    };
  }
  if (
    !isNonNegativeSafeInteger(value.revision) ||
    value.revision < 1 ||
    !isNonNegativeSafeInteger(value.updatedAt)
  ) {
    return {
      status: "invalid",
      reason: "mapping revision metadata is invalid",
    };
  }
  if (value.dimension !== config.dimension) {
    return {
      status: "invalid",
      reason: `mapping dimension ${String(value.dimension)} does not match ${config.dimension}`,
    };
  }
  if (value.indexFileName !== config.indexFileName) {
    return {
      status: "invalid",
      reason: "mapping index filename does not match the configured index",
    };
  }
  if (
    !Array.isArray(value.documents) ||
    value.documents.length > config.maxElements ||
    !Array.isArray(value.tabDocuments) ||
    value.tabDocuments.length > value.documents.length ||
    !isNonNegativeSafeInteger(value.nextLabel) ||
    value.nextLabel > MAX_HNSW_LABEL
  ) {
    return {
      status: "invalid",
      reason: "mapping collection metadata is invalid",
    };
  }

  const documents: Array<[number, VectorDocument]> = [];
  const documentsByLabel = new Map<number, VectorDocument>();
  for (const entry of value.documents) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return { status: "invalid", reason: "document mapping entry is invalid" };
    }
    const [label, rawDocument] = entry;
    if (
      !isNonNegativeSafeInteger(label) ||
      label > MAX_HNSW_LABEL ||
      documentsByLabel.has(label) ||
      !isRecord(rawDocument) ||
      typeof rawDocument.id !== "string" ||
      !isNonNegativeSafeInteger(rawDocument.tabId) ||
      typeof rawDocument.url !== "string" ||
      typeof rawDocument.title !== "string" ||
      !isRecord(rawDocument.chunk) ||
      typeof rawDocument.chunk.text !== "string" ||
      typeof rawDocument.chunk.source !== "string" ||
      !isNonNegativeSafeInteger(rawDocument.chunk.index) ||
      !isNonNegativeSafeInteger(rawDocument.chunk.wordCount) ||
      typeof rawDocument.timestamp !== "number" ||
      !Number.isFinite(rawDocument.timestamp) ||
      rawDocument.timestamp < 0
    ) {
      return { status: "invalid", reason: "document mapping data is invalid" };
    }
    const embedding = parsePersistedEmbedding(
      rawDocument.embedding,
      config.dimension,
    );
    if (!embedding) {
      return { status: "invalid", reason: "document embedding is invalid" };
    }

    const document: VectorDocument = {
      id: rawDocument.id,
      tabId: rawDocument.tabId,
      url: rawDocument.url,
      title: rawDocument.title,
      chunk: {
        text: rawDocument.chunk.text,
        source: rawDocument.chunk.source,
        index: rawDocument.chunk.index,
        wordCount: rawDocument.chunk.wordCount,
      },
      embedding,
      timestamp: rawDocument.timestamp,
    };
    documentsByLabel.set(label, document);
    documents.push([label, document]);
  }

  const tabDocuments: Array<[number, number[]]> = [];
  const seenTabs = new Set<number>();
  const labelsInTabs = new Set<number>();
  for (const entry of value.tabDocuments) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return { status: "invalid", reason: "tab mapping entry is invalid" };
    }
    const [tabId, rawLabels] = entry;
    if (
      !isNonNegativeSafeInteger(tabId) ||
      seenTabs.has(tabId) ||
      !Array.isArray(rawLabels) ||
      rawLabels.length === 0
    ) {
      return { status: "invalid", reason: "tab mapping data is invalid" };
    }
    seenTabs.add(tabId);
    const labels: number[] = [];
    const labelsForTab = new Set<number>();
    for (const label of rawLabels) {
      const document = documentsByLabel.get(label as number);
      if (
        !isNonNegativeSafeInteger(label) ||
        labelsForTab.has(label) ||
        labelsInTabs.has(label) ||
        !document ||
        document.tabId !== tabId
      ) {
        return { status: "invalid", reason: "tab labels are inconsistent" };
      }
      labelsForTab.add(label);
      labelsInTabs.add(label);
      labels.push(label);
    }
    tabDocuments.push([tabId, labels]);
  }

  if (labelsInTabs.size !== documentsByLabel.size) {
    return {
      status: "invalid",
      reason: "not every document label belongs to exactly one tab",
    };
  }

  if (
    !Array.isArray(value.completedTabPages) ||
    value.completedTabPages.length > tabDocuments.length
  ) {
    return {
      status: "invalid",
      reason: "completed page metadata is invalid",
    };
  }

  const tabLabelsById = new Map(tabDocuments);
  const completedTabPages: Array<[number, PersistedTabPageCompletion]> = [];
  const completedTabs = new Set<number>();
  for (const entry of value.completedTabPages) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return {
        status: "invalid",
        reason: "completed page entry is invalid",
      };
    }
    const [tabId, rawCompletion] = entry;
    const tabLabels = tabLabelsById.get(tabId as number);
    if (
      !isNonNegativeSafeInteger(tabId) ||
      completedTabs.has(tabId) ||
      !tabLabels ||
      !isRecord(rawCompletion) ||
      typeof rawCompletion.pageKey !== "string" ||
      typeof rawCompletion.url !== "string" ||
      typeof rawCompletion.title !== "string" ||
      rawCompletion.pageKey !==
        `${rawCompletion.url}\u0000${rawCompletion.title}` ||
      !Array.isArray(rawCompletion.labels) ||
      rawCompletion.labels.length === 0 ||
      !isNonNegativeSafeInteger(rawCompletion.expectedCount) ||
      rawCompletion.expectedCount === 0 ||
      rawCompletion.expectedCount !== rawCompletion.labels.length ||
      rawCompletion.labels.length !== tabLabels.length
    ) {
      return {
        status: "invalid",
        reason: "completed page data is invalid",
      };
    }

    const tabLabelSet = new Set(tabLabels);
    const completionLabels = new Set<number>();
    for (const label of rawCompletion.labels) {
      const document = documentsByLabel.get(label as number);
      if (
        !isNonNegativeSafeInteger(label) ||
        completionLabels.has(label) ||
        !tabLabelSet.has(label) ||
        !document ||
        document.tabId !== tabId ||
        document.url !== rawCompletion.url ||
        document.title !== rawCompletion.title
      ) {
        return {
          status: "invalid",
          reason: "completed page labels are inconsistent",
        };
      }
      completionLabels.add(label);
    }
    if (
      completionLabels.size !== tabLabelSet.size ||
      tabLabels.some((label) => !completionLabels.has(label))
    ) {
      return {
        status: "invalid",
        reason: "completed page labels do not exactly match the tab",
      };
    }

    completedTabs.add(tabId);
    completedTabPages.push([
      tabId,
      {
        pageKey: rawCompletion.pageKey,
        url: rawCompletion.url,
        title: rawCompletion.title,
        labels: [...completionLabels].sort((left, right) => left - right),
        expectedCount: rawCompletion.expectedCount,
      },
    ]);
  }

  let maxLabel = -1;
  for (const label of documentsByLabel.keys()) {
    maxLabel = Math.max(maxLabel, label);
  }
  if (value.nextLabel < maxLabel + 1) {
    return { status: "invalid", reason: "next vector label is inconsistent" };
  }

  return {
    status: "found",
    value: {
      schemaVersion: VECTOR_MAPPING_SCHEMA_VERSION,
      revision: value.revision,
      updatedAt: value.updatedAt,
      dimension: config.dimension,
      indexFileName: config.indexFileName,
      documents,
      tabDocuments,
      completedTabPages,
      nextLabel: value.nextLabel,
    },
  };
}
