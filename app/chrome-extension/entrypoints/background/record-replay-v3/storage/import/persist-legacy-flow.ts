import type { Flow as LegacyFlow } from "../../../record-replay/types";
import type { FlowV3 } from "../../domain/flow";
import type { StoragePort } from "../../engine/storage/storage-port";
import { createStoragePort } from "../../index";
import { convertFlowV2ToV3 } from "./v2-to-v3";

export interface PersistLegacyFlowToV3Result {
  flow: FlowV3;
  warnings: string[];
}

export async function persistLegacyFlowToV3(
  flow: LegacyFlow,
  options: { storage?: StoragePort } = {},
): Promise<PersistLegacyFlowToV3Result> {
  const converted = convertFlowV2ToV3(
    flow as Parameters<typeof convertFlowV2ToV3>[0],
  );
  if (!converted.success || !converted.data) {
    throw new Error(
      converted.errors.length > 0
        ? converted.errors.join("; ")
        : `Failed to convert legacy flow "${flow.id}" to V3`,
    );
  }

  const storage = options.storage ?? createStoragePort();
  await storage.flows.save(converted.data);

  return {
    flow: converted.data,
    warnings: converted.warnings,
  };
}
