import type { Step } from '../types';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { clickNode, dblclickNode } from './click';
import { fillNode } from './fill';
import { httpNode } from './http';
import { extractNode } from './extract';
import { scriptNode } from './script';
import { openTabNode, switchTabNode, closeTabNode } from './tabs';
import { scrollNode } from './scroll';
import { dragNode } from './drag';
import { keyNode } from './key';
import { waitNode } from './wait';
import { assertNode } from './assert';
import { navigateNode } from './navigate';
import { ifNode } from './conditional';
import { STEP_TYPES } from 'webpage-mcp-shared';
import { foreachNode, whileNode } from './loops';
import { executeFlowNode } from './execute-flow';
import {
  handleDownloadNode,
  screenshotNode,
  triggerEventNode,
  setAttributeNode,
  switchFrameNode,
  loopElementsNode,
} from './download-screenshot-attr-event-frame-loop';

const registry = new Map<string, NodeRuntime<any>>([
  [STEP_TYPES.CLICK, clickNode],
  [STEP_TYPES.DBLCLICK, dblclickNode],
  [STEP_TYPES.FILL, fillNode],
  [STEP_TYPES.HTTP, httpNode],
  [STEP_TYPES.EXTRACT, extractNode],
  [STEP_TYPES.SCRIPT, scriptNode],
  [STEP_TYPES.OPEN_TAB, openTabNode],
  [STEP_TYPES.SWITCH_TAB, switchTabNode],
  [STEP_TYPES.CLOSE_TAB, closeTabNode],
  [STEP_TYPES.SCROLL, scrollNode],
  [STEP_TYPES.DRAG, dragNode],
  [STEP_TYPES.KEY, keyNode],
  [STEP_TYPES.WAIT, waitNode],
  [STEP_TYPES.ASSERT, assertNode],
  [STEP_TYPES.NAVIGATE, navigateNode],
  [STEP_TYPES.IF, ifNode],
  [STEP_TYPES.FOREACH, foreachNode],
  [STEP_TYPES.WHILE, whileNode],
  [STEP_TYPES.EXECUTE_FLOW, executeFlowNode],
  [STEP_TYPES.HANDLE_DOWNLOAD, handleDownloadNode],
  [STEP_TYPES.SCREENSHOT, screenshotNode],
  [STEP_TYPES.TRIGGER_EVENT, triggerEventNode],
  [STEP_TYPES.SET_ATTRIBUTE, setAttributeNode],
  [STEP_TYPES.SWITCH_FRAME, switchFrameNode],
  [STEP_TYPES.LOOP_ELEMENTS, loopElementsNode],
]);

export async function executeStep(ctx: ExecCtx, step: Step): Promise<ExecResult> {
  const rt = registry.get(step.type);
  if (!rt) throw new Error(`unsupported step type: ${String(step.type)}`);
  const v = rt.validate ? rt.validate(step) : { ok: true };
  if (!v.ok) throw new Error((v.errors || []).join(', ') || 'validation failed');
  const out = await rt.run(ctx, step);
  return out || {};
}

export type { ExecCtx, ExecResult, NodeRuntime } from './types';
