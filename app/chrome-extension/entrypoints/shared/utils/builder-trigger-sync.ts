import type {
  Flow as BuilderFlow,
  NodeBase,
} from "@/common/workflow-compat-types";
import type {
  FlowId,
  TriggerId,
} from "@/entrypoints/background/record-replay-v3/domain/ids";
import type { JsonObject } from "@/entrypoints/background/record-replay-v3/domain/json";
import type {
  TriggerSpec,
  UrlMatchRule,
} from "@/entrypoints/background/record-replay-v3/domain/triggers";

export const BUILDER_TRIGGER_ID_PREFIX = "builder_trg";

const URL_RULE_KINDS = new Set<UrlMatchRule["kind"]>([
  "url",
  "domain",
  "path",
]);

type BuilderTriggerMode =
  | "manual"
  | "url"
  | "contextMenu"
  | "command"
  | "dom"
  | "schedule";
type BuilderTriggerSectionMode = "contextMenu" | "command" | "dom";

export interface BuilderTriggerSyncRpc {
  request(method: string, params?: JsonObject): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNumber(value: unknown): number | undefined {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function getConfig(node: NodeBase): Record<string, unknown> {
  return asRecord(node.config) || {};
}

function getModes(config: Record<string, unknown>): Record<string, unknown> {
  return asRecord(config.modes) || {};
}

function isModeEnabled(
  modes: Record<string, unknown>,
  mode: BuilderTriggerMode,
  fallback: boolean,
): boolean {
  return readBoolean(modes[mode], fallback);
}

function isSectionModeEnabled(
  config: Record<string, unknown>,
  modes: Record<string, unknown>,
  mode: BuilderTriggerSectionMode,
  fallback: boolean,
): boolean {
  const section = asRecord(config[mode]);
  const sectionEnabled = section?.enabled;
  if (typeof sectionEnabled === "boolean") {
    return sectionEnabled;
  }
  return isModeEnabled(modes, mode, fallback);
}

function sanitizeIdPart(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return sanitized || "id";
}

function builderTriggerId(
  flowId: FlowId,
  nodeId: string,
  suffix: string,
): TriggerId {
  return `${BUILDER_TRIGGER_ID_PREFIX}_${sanitizeIdPart(flowId)}_${sanitizeIdPart(
    nodeId,
  )}_${sanitizeIdPart(suffix)}` as TriggerId;
}

function maybeArgs(config: Record<string, unknown>): { args?: JsonObject } {
  const args = asRecord(config.args);
  return args ? { args: args as JsonObject } : {};
}

function baseTrigger(
  flowId: FlowId,
  node: NodeBase,
  suffix: string,
  enabled: boolean,
  config: Record<string, unknown>,
): Omit<TriggerSpec, "kind"> {
  return {
    id: builderTriggerId(flowId, node.id, suffix),
    enabled,
    flowId,
    ...maybeArgs(config),
  } as Omit<TriggerSpec, "kind">;
}

function parseUrlRules(node: NodeBase, value: unknown): UrlMatchRule[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Trigger node "${node.id}" URL rules must be an array`);
  }

  return value.flatMap((entry, index): UrlMatchRule[] => {
    const raw = asRecord(entry);
    if (!raw) {
      throw new Error(
        `Trigger node "${node.id}" URL rule ${index + 1} must be an object`,
      );
    }
    const kind = readString(raw.kind);
    const ruleValue = readString(raw.value);
    if (!URL_RULE_KINDS.has(kind as UrlMatchRule["kind"]) || !ruleValue) {
      throw new Error(
        `Trigger node "${node.id}" URL rule ${index + 1} needs a kind and value`,
      );
    }
    return [{ kind: kind as UrlMatchRule["kind"], value: ruleValue }];
  });
}

function parseContextMenuContexts(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("contextMenu.contexts must be an array of strings");
  }
  const contexts = value.map((entry) => readString(entry)).filter(Boolean);
  return contexts.length ? contexts : undefined;
}

function buildScheduleTriggers(
  flowId: FlowId,
  node: NodeBase,
  config: Record<string, unknown>,
  baseEnabled: boolean,
): TriggerSpec[] {
  const schedulesValue = config.schedules;
  if (!Array.isArray(schedulesValue) || schedulesValue.length === 0) {
    throw new Error(
      `Trigger node "${node.id}" schedule mode needs at least one schedule`,
    );
  }

  return schedulesValue.map((entry, index): TriggerSpec => {
    const schedule = asRecord(entry);
    if (!schedule) {
      throw new Error(
        `Trigger node "${node.id}" schedule ${index + 1} must be an object`,
      );
    }
    const type = readString(schedule.type) || "once";
    const scheduleId = readString(schedule.id) || String(index + 1);
    const enabled = baseEnabled && readBoolean(schedule.enabled, true);
    if (type === "once") {
      const whenText = readString(schedule.when);
      const whenMs = Date.parse(whenText);
      if (!whenText || !Number.isFinite(whenMs)) {
        throw new Error(
          `Trigger node "${node.id}" once schedule ${index + 1} needs a valid when value`,
        );
      }
      return {
        ...baseTrigger(flowId, node, `once_${scheduleId}`, enabled, config),
        kind: "once",
        whenMs,
      };
    }
    if (type === "interval") {
      const periodMinutes = readNumber(
        schedule.periodMinutes ?? schedule.everyMinutes ?? schedule.when,
      );
      if (periodMinutes === undefined || periodMinutes < 1) {
        throw new Error(
          `Trigger node "${node.id}" interval schedule ${index + 1} needs periodMinutes >= 1`,
        );
      }
      return {
        ...baseTrigger(flowId, node, `interval_${scheduleId}`, enabled, config),
        kind: "interval",
        periodMinutes,
      };
    }
    throw new Error(
      `Trigger node "${node.id}" schedule ${index + 1} uses unsupported type "${type}"`,
    );
  });
}

export function buildBuilderTriggerSpecs(
  flow: Pick<BuilderFlow, "id" | "name" | "nodes">,
  savedFlowId?: string,
  savedFlowName?: string,
): TriggerSpec[] {
  const flowId = (savedFlowId || flow.id) as FlowId;
  const flowName = savedFlowName || flow.name || "Workflow";
  const specs: TriggerSpec[] = [];

  for (const node of flow.nodes || []) {
    if (node.type !== "trigger") {
      continue;
    }

    const config = getConfig(node);
    const modes = getModes(config);
    const baseEnabled = readBoolean(config.enabled, true);

    if (isModeEnabled(modes, "manual", true)) {
      specs.push({
        ...baseTrigger(flowId, node, "manual", baseEnabled, config),
        kind: "manual",
      } as TriggerSpec);
    }

    if (isModeEnabled(modes, "url", false)) {
      const urlConfig = asRecord(config.url) || {};
      const match = parseUrlRules(node, urlConfig.rules);
      if (match.length === 0) {
        throw new Error(
          `Trigger node "${node.id}" URL mode needs at least one URL rule`,
        );
      }
      specs.push({
        ...baseTrigger(flowId, node, "url", baseEnabled, config),
        kind: "url",
        match,
      } as TriggerSpec);
    }

    if (isSectionModeEnabled(config, modes, "contextMenu", false)) {
      const contextMenu = asRecord(config.contextMenu) || {};
      const title = readString(contextMenu.title) || flowName || "Run Workflow";
      specs.push({
        ...baseTrigger(flowId, node, "context_menu", baseEnabled, config),
        kind: "contextMenu",
        title,
        contexts: parseContextMenuContexts(contextMenu.contexts),
      } as TriggerSpec);
    }

    if (isSectionModeEnabled(config, modes, "command", false)) {
      const command = asRecord(config.command) || {};
      const commandKey = readString(command.commandKey);
      if (!commandKey) {
        throw new Error(
          `Trigger node "${node.id}" command mode needs a command key`,
        );
      }
      specs.push({
        ...baseTrigger(flowId, node, "command", baseEnabled, config),
        kind: "command",
        commandKey,
      } as TriggerSpec);
    }

    if (isSectionModeEnabled(config, modes, "dom", false)) {
      const dom = asRecord(config.dom) || {};
      const selector = readString(dom.selector);
      if (!selector) {
        throw new Error(
          `Trigger node "${node.id}" DOM mode needs a selector`,
        );
      }
      specs.push({
        ...baseTrigger(flowId, node, "dom", baseEnabled, config),
        kind: "dom",
        selector,
        appear: readBoolean(dom.appear, true),
        once: readBoolean(dom.once, true),
        debounceMs: readNumber(dom.debounceMs) ?? 800,
      } as TriggerSpec);
    }

    if (isModeEnabled(modes, "schedule", false)) {
      specs.push(...buildScheduleTriggers(flowId, node, config, baseEnabled));
    }
  }

  return specs;
}

export function isBuilderManagedTriggerForFlow(
  trigger: Pick<TriggerSpec, "id" | "flowId">,
  flowId: FlowId | string,
): boolean {
  return (
    trigger.flowId === flowId &&
    trigger.id.startsWith(
      `${BUILDER_TRIGGER_ID_PREFIX}_${sanitizeIdPart(String(flowId))}_`,
    )
  );
}

export async function syncBuilderManagedTriggers(
  rpc: BuilderTriggerSyncRpc,
  flowId: FlowId,
  desiredTriggers: TriggerSpec[],
): Promise<void> {
  const existingTriggers = ((await rpc.request("rr_v3.listTriggers", {
    flowId,
  })) || []) as TriggerSpec[];
  const existingById = new Map(
    existingTriggers.map((trigger) => [trigger.id, trigger]),
  );
  const desiredIds = new Set(desiredTriggers.map((trigger) => trigger.id));

  for (const trigger of desiredTriggers) {
    await rpc.request(
      existingById.has(trigger.id)
        ? "rr_v3.updateTrigger"
        : "rr_v3.createTrigger",
      { trigger: trigger as unknown as JsonObject },
    );
  }

  for (const trigger of existingTriggers) {
    if (
      isBuilderManagedTriggerForFlow(trigger, flowId) &&
      !desiredIds.has(trigger.id)
    ) {
      await rpc.request("rr_v3.deleteTrigger", { triggerId: trigger.id });
    }
  }
}
