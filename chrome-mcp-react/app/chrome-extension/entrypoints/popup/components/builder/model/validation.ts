import type { NodeBase } from '@/entrypoints/background/record-replay/types';
import { STEP_TYPES } from 'webpage-mcp-shared';

export function validateNode(n: NodeBase): string[] {
  const errs: string[] = [];
  const c: any = n.config || {};

  switch (n.type) {
    case STEP_TYPES.CLICK:
    case STEP_TYPES.DBLCLICK:
    case 'fill': {
      const hasCandidate = !!c?.target?.candidates?.length;
      if (!hasCandidate) errs.push('缺少目标选择器候选');
      if (n.type === 'fill' && (!('value' in c) || c.value === undefined)) errs.push('缺少输入值');
      break;
    }
    case STEP_TYPES.WAIT: {
      if (!c?.condition) errs.push('缺少等待条件');
      break;
    }
    case STEP_TYPES.ASSERT: {
      if (!c?.assert) errs.push('缺少断言条件');
      break;
    }
    case STEP_TYPES.NAVIGATE: {
      if (!c?.url) errs.push('缺少 URL');
      break;
    }
    case STEP_TYPES.HTTP: {
      if (!c?.url) errs.push('HTTP: 缺少 URL');
      if (c?.assign && typeof c.assign === 'object') {
        const pathRe = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+|\[\d+\])*$/;
        for (const v of Object.values(c.assign)) {
          const s = String(v);
          if (!pathRe.test(s)) errs.push(`Assign: 路径非法 ${s}`);
        }
      }
      break;
    }
    case STEP_TYPES.HANDLE_DOWNLOAD: {
      // filenameContains 可选
      break;
    }
    case STEP_TYPES.EXTRACT: {
      if (!c?.saveAs) errs.push('Extract: 需填写保存变量名');
      if (!c?.selector && !c?.js) errs.push('Extract: 需提供 selector 或 js');
      break;
    }
    case STEP_TYPES.SWITCH_TAB: {
      if (!c?.tabId && !c?.urlContains && !c?.titleContains)
        errs.push('SwitchTab: 需提供 tabId 或 URL/标题包含');
      break;
    }
    case STEP_TYPES.SCREENSHOT: {
      // selector 可空（全页/可视区），不强制
      break;
    }
    case STEP_TYPES.TRIGGER_EVENT: {
      const hasCandidate = !!c?.target?.candidates?.length;
      if (!hasCandidate) errs.push('缺少目标选择器候选');
      if (!String(c?.event || '').trim()) errs.push('需提供事件类型');
      break;
    }
    case STEP_TYPES.IF: {
      const arr = Array.isArray(c?.branches) ? c.branches : [];
      if (arr.length === 0) errs.push('需添加至少一个条件分支');
      for (let i = 0; i < arr.length; i++) {
        if (!String(arr[i]?.expr || '').trim()) errs.push(`分支${i + 1}: 需填写条件表达式`);
      }
      break;
    }
    case STEP_TYPES.SET_ATTRIBUTE: {
      const hasCandidate = !!c?.target?.candidates?.length;
      if (!hasCandidate) errs.push('缺少目标选择器候选');
      if (!String(c?.name || '').trim()) errs.push('需提供属性名');
      break;
    }
    case STEP_TYPES.LOOP_ELEMENTS: {
      if (!String(c?.selector || '').trim()) errs.push('需提供元素选择器');
      if (!String(c?.subflowId || '').trim()) errs.push('需提供子流 ID');
      break;
    }
    case STEP_TYPES.SWITCH_FRAME: {
      // Both index/urlContains optional; empty means switch back to top frame
      break;
    }
    case STEP_TYPES.EXECUTE_FLOW: {
      if (!String(c?.flowId || '').trim()) errs.push('需选择要执行的工作流');
      break;
    }
    case STEP_TYPES.CLOSE_TAB: {
      // 允许空（关闭当前标签页），不强制
      break;
    }
    case STEP_TYPES.SCRIPT: {
      // 若配置了 saveAs/assign，应提供 code
      const hasAssign = c?.assign && Object.keys(c.assign).length > 0;
      if ((c?.saveAs || hasAssign) && !String(c?.code || '').trim())
        errs.push('Script: 配置了保存/映射但缺少代码');
      if (hasAssign) {
        const pathRe = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+|\[\d+\])*$/;
        for (const v of Object.values(c.assign || {})) {
          const s = String(v);
          if (!pathRe.test(s)) errs.push(`Assign: 路径非法 ${s}`);
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
