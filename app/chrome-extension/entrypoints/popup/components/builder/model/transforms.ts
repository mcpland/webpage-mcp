import type {
  Flow as BuilderFlow,
  NodeBase,
  Edge as BuilderEdge,
} from '@/common/workflow-compat-types';
import {
  nodesToSteps as sharedNodesToSteps,
  stepsToNodes as sharedStepsToNodes,
  topoOrder as sharedTopoOrder,
} from 'webpage-mcp-shared';
import { STEP_TYPES } from 'webpage-mcp-shared';
import { EDGE_LABELS } from 'webpage-mcp-shared';

export function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

export type NodeType = NodeBase['type'];

export function defaultConfigFor(t: NodeType): any {
  if ((t as any) === 'trigger') return { type: 'manual', description: '' };
  if (t === STEP_TYPES.CLICK || t === STEP_TYPES.FILL)
    return { target: { candidates: [] }, value: t === STEP_TYPES.FILL ? '' : undefined };
  if (t === STEP_TYPES.IF)
    return { branches: [{ id: newId('case'), name: '', expr: '' }], else: true };
  if (t === STEP_TYPES.NAVIGATE) return { url: '' };
  if (t === STEP_TYPES.WAIT) return { condition: { text: '', appear: true } };
  if (t === STEP_TYPES.ASSERT) return { assert: { exists: '' } };
  if (t === STEP_TYPES.KEY) return { keys: '' };
  if (t === STEP_TYPES.DELAY) return { ms: 1000 };
  if (t === STEP_TYPES.HTTP) return { method: 'GET', url: '', headers: {}, body: null, saveAs: '' };
  if (t === STEP_TYPES.EXTRACT) return { selector: '', attr: 'text', js: '', saveAs: '' };
  if (t === STEP_TYPES.SCREENSHOT) return { selector: '', fullPage: false, saveAs: 'shot' };
  if (t === STEP_TYPES.DRAG)
    return { start: { candidates: [] }, end: { candidates: [] }, path: [] };
  if (t === STEP_TYPES.SCROLL)
    return { mode: 'offset', offset: { x: 0, y: 300 }, target: { candidates: [] } };
  if (t === STEP_TYPES.TRIGGER_EVENT)
    return { target: { candidates: [] }, event: 'input', bubbles: true, cancelable: false };
  if (t === STEP_TYPES.SET_ATTRIBUTE) return { target: { candidates: [] }, name: '', value: '' };
  if (t === STEP_TYPES.LOOP_ELEMENTS)
    return { selector: '', saveAs: 'elements', itemVar: 'item', subflowId: '' };
  if (t === STEP_TYPES.SWITCH_FRAME) return { frame: { index: 0, urlContains: '' } };
  if (t === STEP_TYPES.HANDLE_DOWNLOAD)
    return { filenameContains: '', waitForComplete: true, timeoutMs: 60000, saveAs: 'download' };
  if (t === STEP_TYPES.EXECUTE_FLOW) return { flowId: '', inline: true, args: {} };
  if (t === STEP_TYPES.OPEN_TAB) return { url: '', newWindow: false };
  if (t === STEP_TYPES.SWITCH_TAB) return { tabId: null, urlContains: '', titleContains: '' };
  if (t === STEP_TYPES.CLOSE_TAB) return { tabIds: [], url: '' };
  if (t === STEP_TYPES.SCRIPT) return { world: 'ISOLATED', code: '', saveAs: '', assign: {} };
  return {};
}

export function stepsToNodes(steps: any[]): NodeBase[] {
  const base = sharedStepsToNodes(steps) as unknown as NodeBase[];
  // add simple UI positions
  base.forEach((n, i) => {
    (n as any).ui = (n as any).ui || { x: 200, y: 120 + i * 120 };
  });
  return base;
}

export function topoOrder(nodes: NodeBase[], edges: BuilderEdge[]): NodeBase[] {
  const filtered = (edges || []).filter((e) => !e.label || e.label === EDGE_LABELS.DEFAULT);
  return sharedTopoOrder(nodes as any, filtered as any) as any;
}

export function nodesToSteps(nodes: NodeBase[], edges: BuilderEdge[]): any[] {
  // Exclude non-executable nodes like 'trigger' and cut edges from them
  const execNodes = (nodes || []).filter((n) => n.type !== ('trigger' as any));
  const filtered = (edges || []).filter(
    (e) =>
      (!e.label || e.label === EDGE_LABELS.DEFAULT) && !execNodes.every((n) => n.id !== e.from),
  );
  return sharedNodesToSteps(execNodes as any, filtered as any);
}

export function autoChainEdges(nodes: NodeBase[]): BuilderEdge[] {
  const arr: BuilderEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++)
    arr.push({
      id: newId('e'),
      from: nodes[i].id,
      to: nodes[i + 1].id,
      label: EDGE_LABELS.DEFAULT,
    });
  return arr;
}

export function summarizeNode(n?: NodeBase | null): string {
  if (!n) return '';
  if (n.type === STEP_TYPES.CLICK || n.type === STEP_TYPES.FILL)
    return n.config?.target?.candidates?.[0]?.value || 'Selector not configured';
  if (n.type === STEP_TYPES.NAVIGATE) return n.config?.url || '';
  if (n.type === STEP_TYPES.KEY) return n.config?.keys || '';
  if (n.type === STEP_TYPES.DELAY) return `${Number(n.config?.ms || 0)}ms`;
  if (n.type === STEP_TYPES.HTTP) return `${n.config?.method || 'GET'} ${n.config?.url || ''}`;
  if (n.type === STEP_TYPES.EXTRACT)
    return `${n.config?.selector || ''} -> ${n.config?.saveAs || ''}`;
  if (n.type === STEP_TYPES.SCREENSHOT)
    return n.config?.selector
      ? `el(${n.config.selector}) -> ${n.config?.saveAs || ''}`
      : `fullPage -> ${n.config?.saveAs || ''}`;
  if (n.type === STEP_TYPES.TRIGGER_EVENT)
    return `${n.config?.event || ''} ${n.config?.target?.candidates?.[0]?.value || ''}`;
  if (n.type === STEP_TYPES.SET_ATTRIBUTE)
    return `${n.config?.name || ''}=${n.config?.value ?? ''}`;
  if (n.type === STEP_TYPES.LOOP_ELEMENTS)
    return `${n.config?.selector || ''} as ${n.config?.itemVar || 'item'} -> ${n.config?.subflowId || ''}`;
  if (n.type === STEP_TYPES.SWITCH_FRAME)
    return n.config?.frame?.urlContains
      ? `url~${n.config.frame.urlContains}`
      : `index=${Number(n.config?.frame?.index ?? 0)}`;
  if (n.type === STEP_TYPES.OPEN_TAB) return `open ${n.config?.url || ''}`;
  if (n.type === STEP_TYPES.SWITCH_TAB)
    return `switch ${n.config?.tabId || n.config?.urlContains || n.config?.titleContains || ''}`;
  if (n.type === STEP_TYPES.CLOSE_TAB) return `close ${n.config?.url || ''}`;
  if (n.type === STEP_TYPES.HANDLE_DOWNLOAD) return `download ${n.config?.filenameContains || ''}`;
  if (n.type === STEP_TYPES.WAIT) return JSON.stringify(n.config?.condition || {});
  if (n.type === STEP_TYPES.ASSERT) return JSON.stringify(n.config?.assert || {});
  if (n.type === STEP_TYPES.IF) {
    const cnt = Array.isArray(n.config?.branches) ? n.config.branches.length : 0;
    return `if/else Number of branches ${cnt}${n.config?.else === false ? '' : ' + else'}`;
  }
  if (n.type === STEP_TYPES.SCRIPT) return (n.config?.code || '').slice(0, 30);
  if (n.type === STEP_TYPES.DRAG) {
    const a = n.config?.start?.candidates?.[0]?.value || '';
    const b = n.config?.end?.candidates?.[0]?.value || '';
    return a || b ? `${a} -> ${b}` : 'drag';
  }
  if (n.type === STEP_TYPES.SCROLL) {
    const mode = n.config?.mode || 'offset';
    if (mode === 'offset' || mode === 'container') {
      const x = Number(n.config?.offset?.x ?? 0);
      const y = Number(n.config?.offset?.y ?? 0);
      return `${mode} (${x}, ${y})`;
    }
    const sel = n.config?.target?.candidates?.[0]?.value || '';
    return sel ? `element ${sel}` : 'element';
  }
  if (n.type === STEP_TYPES.EXECUTE_FLOW) return `exec ${n.config?.flowId || ''}`;
  return '';
}

export function cloneFlow(flow: BuilderFlow): BuilderFlow {
  return JSON.parse(JSON.stringify(flow));
}
