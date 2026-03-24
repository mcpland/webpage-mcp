import type { NodeBase } from '@/common/workflow-compat-types';
import { STEP_TYPES } from 'webpage-mcp-shared';

export function validateNode(n: NodeBase): string[] {
  const errs: string[] = [];
  const c: any = n.config || {};

  switch (n.type) {
    case STEP_TYPES.CLICK:
    case STEP_TYPES.DBLCLICK:
    case 'fill': {
      const hasCandidate = !!c?.target?.candidates?.length;
      if (!hasCandidate) errs.push('Missing target selector candidate');
      if (n.type === 'fill' && (!('value' in c) || c.value === undefined)) errs.push('Missing input value');
      break;
    }
    case STEP_TYPES.WAIT: {
      if (!c?.condition) errs.push('Missing wait condition');
      break;
    }
    case STEP_TYPES.ASSERT: {
      if (!c?.assert) errs.push('Missing assertion condition');
      break;
    }
    case STEP_TYPES.NAVIGATE: {
      if (!c?.url) errs.push('Missing URL');
      break;
    }
    case STEP_TYPES.HTTP: {
      if (!c?.url) errs.push('HTTP: Missing URL');
      if (c?.assign && typeof c.assign === 'object') {
        const pathRe = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+|\[\d+\])*$/;
        for (const v of Object.values(c.assign)) {
          const s = String(v);
          if (!pathRe.test(s)) errs.push(`Assign: Illegal path ${s}`);
        }
      }
      break;
    }
    case STEP_TYPES.HANDLE_DOWNLOAD: {
      // filenameContains Optional
      break;
    }
    case STEP_TYPES.EXTRACT: {
      if (!c?.saveAs) errs.push('Extract: Need to fill in the save variable name');
      if (!c?.selector && !c?.js) errs.push('Extract: Need to provide selector or js');
      break;
    }
    case STEP_TYPES.SWITCH_TAB: {
      if (!c?.tabId && !c?.urlContains && !c?.titleContains)
        errs.push('SwitchTab: Requires tabId or URL/title contains ');
      break;
    }
    case STEP_TYPES.SCREENSHOT: {
      // selector Can be empty (full page/visible area), not mandatory
      break;
    }
    case STEP_TYPES.TRIGGER_EVENT: {
      const hasCandidate = !!c?.target?.candidates?.length;
      if (!hasCandidate) errs.push('Missing target selector candidate');
      if (!String(c?.event || '').trim()) errs.push('Event type required');
      break;
    }
    case STEP_TYPES.IF: {
      const arr = Array.isArray(c?.branches) ? c.branches : [];
      if (arr.length === 0) errs.push('At least one conditional branch needs to be added');
      for (let i = 0; i < arr.length; i++) {
        if (!String(arr[i]?.expr || '').trim()) errs.push(`branch${i + 1}: Need to fill in the conditional expression`);
      }
      break;
    }
    case STEP_TYPES.SET_ATTRIBUTE: {
      const hasCandidate = !!c?.target?.candidates?.length;
      if (!hasCandidate) errs.push('Missing target selector candidate');
      if (!String(c?.name || '').trim()) errs.push('Attribute name required');
      break;
    }
    case STEP_TYPES.LOOP_ELEMENTS: {
      if (!String(c?.selector || '').trim()) errs.push('Element selector required');
      if (!String(c?.subflowId || '').trim()) errs.push('Subflow ID required');
      break;
    }
    case STEP_TYPES.SWITCH_FRAME: {
      // Both index/urlContains optional; empty means switch back to top frame
      break;
    }
    case STEP_TYPES.EXECUTE_FLOW: {
      if (!String(c?.flowId || '').trim()) errs.push('Need to select the workflow to be executed');
      break;
    }
    case STEP_TYPES.CLOSE_TAB: {
      // Allow empty (close current tab), not mandatory
      break;
    }
    case STEP_TYPES.SCRIPT: {
      // If saveAs/assign is configured, code should be provided
      const hasAssign = c?.assign && Object.keys(c.assign).length > 0;
      if ((c?.saveAs || hasAssign) && !String(c?.code || '').trim())
        errs.push('Script: Save/Map configured but code missing');
      if (hasAssign) {
        const pathRe = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+|\[\d+\])*$/;
        for (const v of Object.values(c.assign || {})) {
          const s = String(v);
          if (!pathRe.test(s)) errs.push(`Assign: Illegal path ${s}`);
        }
      }
      break;
    }
  }
  return errs;
}

export function validateFlow(nodes: NodeBase[]): {
  totalErrors: number;
  nodeErrors: Record<string, string[]>;
} {
  const nodeErrors: Record<string, string[]> = {};
  let totalErrors = 0;
  for (const n of nodes) {
    const e = validateNode(n);
    if (e.length) {
      nodeErrors[n.id] = e;
      totalErrors += e.length;
    }
  }
  return { totalErrors, nodeErrors };
}
