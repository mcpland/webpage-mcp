import type { StoragePort } from "../../engine/storage/storage-port";
import type { FlowV3 } from "../../domain/flow";
import { convertFlowV2ToV3 } from "./v2-to-v3";
import {
  listFlows as listLegacyFlows,
  listPublished as listLegacyPublished,
} from "../../../record-replay/flow-store";
import { mergeFlowToolMetadata } from "../../flows/publish";

const LEGACY_MIGRATION_FLAG = "rr_v3_legacy_flows_migrated_v1";

type Logger = Pick<Console, "info" | "warn" | "error">;

interface LegacyPublishedFlowInfo {
  id: string;
  slug: string;
  version: number;
  name: string;
  description?: string;
}

interface LegacyFlowSource {
  listFlows(): Promise<unknown[]>;
  listPublished(): Promise<LegacyPublishedFlowInfo[]>;
}

interface KeyValueStore {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface LegacyMigrationResult {
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
}

function createDefaultLegacySource(): LegacyFlowSource {
  return {
    listFlows: async () => listLegacyFlows(),
    listPublished: async () => listLegacyPublished(),
  };
}

function applyLegacyPublishedInfo(
  flow: FlowV3,
  publishedInfo: LegacyPublishedFlowInfo | undefined,
): FlowV3 {
  if (!publishedInfo) {
    return flow;
  }

  return {
    ...flow,
    meta: mergeFlowToolMetadata(flow.meta, {
      published: true,
      slug: publishedInfo.slug,
      description:
        publishedInfo.description ||
        flow.meta?.tool?.description ||
        flow.description,
    }),
  };
}

function mergeLegacyPublishInfoIntoExisting(
  existingFlow: FlowV3,
  publishedInfo: LegacyPublishedFlowInfo | undefined,
): FlowV3 | null {
  if (!publishedInfo) {
    return null;
  }

  const currentTool = existingFlow.meta?.tool;
  const nextDescription =
    currentTool?.description ||
    publishedInfo.description ||
    existingFlow.description;
  const nextSlug = currentTool?.slug || publishedInfo.slug;
  const nextPublished = currentTool?.published ?? false;

  if (
    nextPublished &&
    currentTool?.slug === nextSlug &&
    currentTool?.description === nextDescription
  ) {
    return null;
  }

  return {
    ...existingFlow,
    updatedAt: new Date().toISOString() as FlowV3["updatedAt"],
    meta: mergeFlowToolMetadata(existingFlow.meta, {
      published: true,
      slug: nextSlug,
      description: nextDescription,
    }),
  };
}

export async function migrateLegacyFlowsToV3(options: {
  storage: StoragePort;
  logger?: Logger;
  legacySource?: LegacyFlowSource;
  kv?: KeyValueStore;
}): Promise<LegacyMigrationResult> {
  const logger = options.logger ?? console;
  const kv = options.kv ?? chrome.storage.local;
  const flagState = await kv.get([LEGACY_MIGRATION_FLAG]);
  if (flagState[LEGACY_MIGRATION_FLAG]) {
    return { imported: 0, updated: 0, skipped: 0, errors: [] };
  }

  const legacySource = options.legacySource ?? createDefaultLegacySource();
  const [existingFlows, legacyFlows, legacyPublished] = await Promise.all([
    options.storage.flows.list(),
    legacySource.listFlows(),
    legacySource.listPublished(),
  ]);

  const existingById = new Map(existingFlows.map((flow) => [flow.id, flow]));
  const publishedById = new Map(legacyPublished.map((item) => [item.id, item]));

  const result: LegacyMigrationResult = {
    imported: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  for (const legacyFlow of legacyFlows) {
    const converted = convertFlowV2ToV3(
      legacyFlow as Parameters<typeof convertFlowV2ToV3>[0],
    );
    if (!converted.success || !converted.data) {
      result.errors.push(
        `Failed to migrate legacy flow "${String((legacyFlow as { id?: unknown })?.id ?? "unknown")}": ${converted.errors.join("; ")}`,
      );
      result.skipped += 1;
      continue;
    }

    const migratedFlow = applyLegacyPublishedInfo(
      converted.data,
      publishedById.get(converted.data.id),
    );
    const existing = existingById.get(migratedFlow.id);

    if (!existing) {
      await options.storage.flows.save(migratedFlow);
      existingById.set(migratedFlow.id, migratedFlow);
      result.imported += 1;
      continue;
    }

    const patchedExisting = mergeLegacyPublishInfoIntoExisting(
      existing,
      publishedById.get(migratedFlow.id),
    );
    if (!patchedExisting) {
      result.skipped += 1;
      continue;
    }

    await options.storage.flows.save(patchedExisting);
    existingById.set(patchedExisting.id, patchedExisting);
    result.updated += 1;
  }

  await kv.set({ [LEGACY_MIGRATION_FLAG]: true });

  if (result.imported || result.updated || result.errors.length > 0) {
    logger.info(
      `[RR-V3] Legacy V2 migration complete: imported=${result.imported}, updated=${result.updated}, skipped=${result.skipped}, errors=${result.errors.length}`,
    );
  }
  for (const error of result.errors) {
    logger.warn(`[RR-V3] ${error}`);
  }

  return result;
}
