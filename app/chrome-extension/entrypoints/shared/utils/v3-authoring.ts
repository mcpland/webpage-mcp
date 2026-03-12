import type { NodeBase } from "@/entrypoints/background/record-replay/types";

type FlowLikeNode =
  | Pick<NodeBase, "type">
  | {
      type?: string;
      kind?: string;
    };

type FlowLike = {
  nodes?: ReadonlyArray<FlowLikeNode | null | undefined>;
  subflows?: Record<string, unknown> | null | undefined;
};

export interface V3AuthoringCompatibility {
  isCompatible: boolean;
  unsupportedNodeTypes: NodeBase["type"][];
  hasSubflows: boolean;
  messages: string[];
}

export const V3_UNSUPPORTED_NODE_TYPES = [
  "executeFlow",
  "foreach",
  "loopElements",
  "while",
] as const satisfies ReadonlyArray<NodeBase["type"]>;

const V3_UNSUPPORTED_NODE_TYPE_SET = new Set<string>(V3_UNSUPPORTED_NODE_TYPES);

const V3_BASE_PALETTE_TYPES = [
  "click",
  "drag",
  "scroll",
  "fill",
  "if",
  "key",
  "wait",
  "assert",
  "navigate",
  "script",
  "delay",
  "http",
  "extract",
  "screenshot",
  "triggerEvent",
  "setAttribute",
  "switchFrame",
  "handleDownload",
  "openTab",
  "switchTab",
  "closeTab",
] as const satisfies ReadonlyArray<NodeBase["type"]>;

function getNodeType(node: FlowLikeNode | null | undefined): string | null {
  if (!node || typeof node !== "object") {
    return null;
  }
  if (typeof node.type === "string" && node.type.trim()) {
    return node.type.trim();
  }
  const maybeKind = (node as { kind?: string }).kind;
  if (typeof maybeKind === "string" && maybeKind.trim()) {
    return maybeKind.trim();
  }
  return null;
}

export function getV3AuthoringPaletteTypes(
  options: {
    includeTrigger?: boolean;
  } = {},
): NodeBase["type"][] {
  const { includeTrigger = false } = options;
  return includeTrigger
    ? (["trigger", ...V3_BASE_PALETTE_TYPES] as NodeBase["type"][])
    : [...V3_BASE_PALETTE_TYPES];
}

export function canCreateV3AuthoringNodeType(
  type: string,
  options: {
    includeTrigger?: boolean;
  } = {},
): boolean {
  return getV3AuthoringPaletteTypes(options).includes(type as NodeBase["type"]);
}

export function isV3UnsupportedNodeType(
  type: string,
): type is NodeBase["type"] {
  return V3_UNSUPPORTED_NODE_TYPE_SET.has(type);
}

export function getV3AuthoringCompatibility(
  flow: FlowLike | null | undefined,
): V3AuthoringCompatibility {
  const unsupportedNodeTypes = Array.from(
    new Set(
      (flow?.nodes || [])
        .map((node) => getNodeType(node))
        .filter(
          (type): type is NodeBase["type"] =>
            !!type && isV3UnsupportedNodeType(type),
        ),
    ),
  ).sort() as NodeBase["type"][];

  const hasSubflows = Object.keys(flow?.subflows || {}).length > 0;
  const messages: string[] = [];

  if (unsupportedNodeTypes.length > 0) {
    messages.push(
      `Unsupported node types for V3 authoring: ${unsupportedNodeTypes.join(", ")}.`,
    );
  }
  if (hasSubflows) {
    messages.push("Subflows are not supported in V3 authoring yet.");
  }

  return {
    isCompatible: unsupportedNodeTypes.length === 0 && !hasSubflows,
    unsupportedNodeTypes,
    hasSubflows,
    messages,
  };
}
