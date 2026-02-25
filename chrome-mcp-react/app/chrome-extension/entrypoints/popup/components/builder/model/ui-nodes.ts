// ui-nodes.ts — UI registry for builder nodes (sidebar, canvas, properties)
// Comments in English to explain intent.

import { markRaw, type Component } from 'vue';
import type { NodeBase, NodeType } from '@/entrypoints/background/record-replay/types';
import { NODE_TYPES } from '@/common/node-types';
import { defaultConfigFor as fallbackDefaultConfig } from '@/entrypoints/popup/components/builder/model/transforms';
import { validateNode as fallbackValidateNode } from '@/entrypoints/popup/components/builder/model/validation';
import {
  listNodeSpecs,
  getNodeSpec,
} from '@/entrypoints/popup/components/builder/model/node-spec-registry';
import { STEP_TYPES } from 'webpage-mcp-shared';

// Canvas renderer components
import NodeCard from '@/entrypoints/popup/components/builder/components/nodes/NodeCard.vue';
import NodeIf from '@/entrypoints/popup/components/builder/components/nodes/NodeIf.vue';

// Property components (per-node or shared)
import PropClick from '@/entrypoints/popup/components/builder/components/properties/PropertyClick.vue';
import PropFill from '@/entrypoints/popup/components/builder/components/properties/PropertyFill.vue';
import PropTriggerEvent from '@/entrypoints/popup/components/builder/components/properties/PropertyTriggerEvent.vue';
import PropSetAttribute from '@/entrypoints/popup/components/builder/components/properties/PropertySetAttribute.vue';
import PropDrag from '@/entrypoints/popup/components/builder/components/properties/PropertyDrag.vue';
import PropScroll from '@/entrypoints/popup/components/builder/components/properties/PropertyScroll.vue';
import PropNavigate from '@/entrypoints/popup/components/builder/components/properties/PropertyNavigate.vue';
import PropertyFromSpec from '@/entrypoints/popup/components/builder/components/properties/PropertyFromSpec';
import { registerBuiltinSpecs } from '@/entrypoints/popup/components/builder/model/node-specs-builtin';

// Register builtin NodeSpecs at module init
registerBuiltinSpecs();
import PropWait from '@/entrypoints/popup/components/builder/components/properties/PropertyWait.vue';
import PropAssert from '@/entrypoints/popup/components/builder/components/properties/PropertyAssert.vue';
import PropDelay from '@/entrypoints/popup/components/builder/components/properties/PropertyDelay.vue';
import PropHttp from '@/entrypoints/popup/components/builder/components/properties/PropertyHttp.vue';
import PropExtract from '@/entrypoints/popup/components/builder/components/properties/PropertyExtract.vue';
import PropScreenshot from '@/entrypoints/popup/components/builder/components/properties/PropertyScreenshot.vue';
import PropLoopElements from '@/entrypoints/popup/components/builder/components/properties/PropertyLoopElements.vue';
import PropSwitchFrame from '@/entrypoints/popup/components/builder/components/properties/PropertySwitchFrame.vue';
import PropHandleDownload from '@/entrypoints/popup/components/builder/components/properties/PropertyHandleDownload.vue';
import PropExecuteFlow from '@/entrypoints/popup/components/builder/components/properties/PropertyExecuteFlow.vue';
import PropOpenTab from '@/entrypoints/popup/components/builder/components/properties/PropertyOpenTab.vue';
import PropSwitchTab from '@/entrypoints/popup/components/builder/components/properties/PropertySwitchTab.vue';
import PropCloseTab from '@/entrypoints/popup/components/builder/components/properties/PropertyCloseTab.vue';
import PropKey from '@/entrypoints/popup/components/builder/components/properties/PropertyKey.vue';
import PropIf from '@/entrypoints/popup/components/builder/components/properties/PropertyIf.vue';
import PropForeach from '@/entrypoints/popup/components/builder/components/properties/PropertyForeach.vue';
import PropWhile from '@/entrypoints/popup/components/builder/components/properties/PropertyWhile.vue';
import PropScript from '@/entrypoints/popup/components/builder/components/properties/PropertyScript.vue';
import PropTrigger from '@/entrypoints/popup/components/builder/components/properties/PropertyTrigger.vue';

export type NodeCategory = 'Flow' | 'Actions' | 'Logic' | 'Tools' | 'Tabs' | 'Page';

export interface NodeUIConfig {
  type: NodeType;
  label: string;
  category: NodeCategory;
  iconClass: string; // reuse existing Sidebar.css color classes
  canvas: Component; // canvas renderer
  property: Component; // property renderer
  docUrl?: string;
  io?: { inputs?: number | 'any'; outputs?: number | 'any' };
  defaultConfig?: () => any;
  validate?: (node: NodeBase) => string[];
}

// Registry contents generated from NodeSpec; use existing color/icon CSS classes
const baseCard = NodeCard as Component;

function specToUi(spec: any): NodeUIConfig {
  const canvas = spec.type === (STEP_TYPES.IF as any) ? (NodeIf as Component) : baseCard;
  const outputs = Array.isArray(spec.ports?.outputs) ? spec.ports.outputs.length : 'any';
  return {
    type: spec.type as any,
    label: spec.display?.label || String(spec.type),
    category: (spec.display?.category || 'Actions') as any,
    iconClass: spec.display?.iconClass || 'icon-default',
    // Mark component refs as raw to prevent them from being proxied/reactive by consumers
    canvas: markRaw(canvas) as Component,
    property: markRaw(PropertyFromSpec) as Component,
    io: { inputs: spec.ports?.inputs ?? 1, outputs },
    defaultConfig: () => ({ ...(spec.defaults || {}) }),
    validate: (node: NodeBase) => {
      try {
        const cfg = (node as any)?.config || {};
        return (getNodeSpec(node.type as any)?.validate?.(cfg) || []) as string[];
      } catch {
        return [];
      }
    },
  } as any;
}

export const NODE_UI_LIST: NodeUIConfig[] = listNodeSpecs().map(specToUi);

const REGISTRY_MAP: Record<string, NodeUIConfig> = Object.fromEntries(
  NODE_UI_LIST.map((n) => [n.type, n]),
);
export const NODE_UI_REGISTRY = REGISTRY_MAP as Record<NodeType, NodeUIConfig>;

export const NODE_CATEGORIES: NodeCategory[] = [
  'Flow',
  'Actions',
  'Logic',
  'Tools',
  'Tabs',
  'Page',
];

export function listByCategory(): Record<NodeCategory, NodeUIConfig[]> {
  const out: Record<NodeCategory, NodeUIConfig[]> = {
    Flow: [],
    Actions: [],
    Logic: [],
    Tools: [],
    Tabs: [],
    Page: [],
  };
  for (const n of NODE_UI_LIST) out[n.category].push(n);
  return out;
}

export function canvasTypeKey(t: NodeType): string {
  // Map to VueFlow node-types key, unique per node type
  return `rr-${t}`;
}

// Default config resolver with registry override
export function defaultConfigOf(t: NodeType): any {
  // Prefer NodeSpec defaults
  const spec = getNodeSpec(t as any);
  if (spec?.defaults) return { ...spec.defaults };
  const item = (NODE_UI_REGISTRY as any)[t] as NodeUIConfig | undefined;
  if (item?.defaultConfig) return item.defaultConfig();
  return fallbackDefaultConfig(t as any);
}

// Validation via registry where present
export function validateNodeWithRegistry(n: NodeBase): string[] {
  // Prefer NodeSpec validate
  try {
    const spec = getNodeSpec(n.type as any);
    if (spec?.validate) return spec.validate((n as any).config || {}) || [];
  } catch {}
  const item = (NODE_UI_REGISTRY as any)[n.type] as NodeUIConfig | undefined;
  if (item?.validate) {
    try {
      return item.validate(n) || [];
    } catch {}
  }
  return fallbackValidateNode(n);
}

// Allow external modules to register extra UI nodes
export function registerExtraUiNodes(list: NodeUIConfig[]) {
  for (const n of list) {
    (NODE_UI_LIST as any).push(n);
    (REGISTRY_MAP as any)[n.type] = n;
  }
}

// IO constraints helper with sensible defaults for our graph
export function getIoConstraint(t: NodeType): { inputs: number | 'any'; outputs: number | 'any' } {
  const item = (NODE_UI_REGISTRY as any)[t] as NodeUIConfig | undefined;
  const io = item?.io || {};
  // Defaults: most nodes have single input; outputs unlimited unless otherwise defined
  let inputs: number | 'any' = (io.inputs as any) ?? 1;
  let outputs: number | 'any' = (io.outputs as any) ?? 'any';
  if ((t as any) === 'trigger') inputs = 0;
  if ((t as any) === 'if') outputs = 'any';
  return { inputs, outputs };
}
