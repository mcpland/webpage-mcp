import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { nodesToSteps } from 'webpage-mcp-shared';
import { getFlow, saveFlow } from '../record-replay/flow-store';
import type { Flow } from '../record-replay/types';
import { applyFlowParameterSuggestions } from './flow-parameterization';

type FlowHintLevel = 'info' | 'warning';

interface FlowHint {
  level: FlowHintLevel;
  code: string;
  message: string;
  nodeId?: string;
}

function countFlowNodes(flow: Flow): number {
  if (Array.isArray(flow.nodes)) return flow.nodes.length;
  if (Array.isArray(flow.steps)) return flow.steps.length;
  return 0;
}

function collectFlowHints(flow: Flow): FlowHint[] {
  const hints: FlowHint[] = [];
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];

  const hasAssert = nodes.some((node) => node.type === 'assert');
  if (!hasAssert) {
    hints.push({
      level: 'warning',
      code: 'missing_assertion',
      message: 'No assert node found. Consider adding at least one checkpoint.',
    });
  }

  for (const node of nodes) {
    const target = node?.config && typeof node.config === 'object' ? (node.config as any).target : null;
    const selector = target && typeof target.selector === 'string' ? target.selector : '';
    if (selector) {
      if (selector.includes(':nth-of-type(') || selector.startsWith('/')) {
        hints.push({
          level: 'warning',
          code: 'unstable_selector',
          message: 'Selector may be unstable (structural or XPath). Prefer data-* or aria selectors.',
          nodeId: node.id,
        });
      }
    }

    if (node.type === 'fill') {
      const value = node?.config && (node.config as any).value;
      if (typeof value === 'string' && value.trim() && !/^\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(value.trim())) {
        hints.push({
          level: 'info',
          code: 'literal_fill_value',
          message: 'Fill value looks literal. Consider converting it to a variable.',
          nodeId: node.id,
        });
      }
    }
  }

  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1];
    const curr = nodes[i];
    if (!prev || !curr) continue;
    const prevSel = (prev.config as any)?.target?.selector || '';
    const currSel = (curr.config as any)?.target?.selector || '';
    if (prev.type === curr.type && prevSel && currSel && prevSel === currSel) {
      hints.push({
        level: 'info',
        code: 'possible_redundant_step',
        message: 'Consecutive steps operate on the same selector. Check for redundancy.',
        nodeId: curr.id,
      });
    }
  }

  return hints;
}

function toSteps(flow: Flow): any[] {
  if (Array.isArray(flow.nodes) && flow.nodes.length > 0) {
    return nodesToSteps(flow.nodes as any, Array.isArray(flow.edges) ? (flow.edges as any) : []);
  }
  if (Array.isArray(flow.steps)) {
    return flow.steps as any[];
  }
  return [];
}

function asQuoted(value: unknown): string {
  return JSON.stringify(value == null ? '' : String(value));
}

function getStepSelector(step: any): string {
  const target = step?.target;
  if (!target || typeof target !== 'object') return '';
  if (typeof target.selector === 'string' && target.selector.trim()) return target.selector.trim();
  if (Array.isArray(target.candidates) && target.candidates.length > 0) {
    const first = target.candidates.find((c: any) => typeof c?.value === 'string' && c.value.trim());
    if (first) return String(first.value).trim();
  }
  return '';
}

function buildPlaywrightCode(flow: Flow): string {
  const lines: string[] = [];
  lines.push(`// Generated from flow: ${flow.name}`);
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  lines.push(`test(${asQuoted(flow.name)}, async ({ page }) => {`);
  for (const step of toSteps(flow)) {
    const selector = getStepSelector(step);
    switch (step.type) {
      case 'navigate':
        lines.push(`  await page.goto(${asQuoted(step.url || '')});`);
        break;
      case 'click':
        if (selector) lines.push(`  await page.locator(${asQuoted(selector)}).click();`);
        break;
      case 'dblclick':
        if (selector) lines.push(`  await page.locator(${asQuoted(selector)}).dblclick();`);
        break;
      case 'fill': {
        if (!selector) break;
        if (typeof step.value === 'boolean') {
          lines.push(`  await page.locator(${asQuoted(selector)}).setChecked(${step.value});`);
        } else {
          lines.push(`  await page.locator(${asQuoted(selector)}).fill(${asQuoted(step.value || '')});`);
        }
        break;
      }
      case 'key':
        lines.push(`  await page.keyboard.press(${asQuoted(step.keys || '')});`);
        break;
      case 'scroll':
        if (step.mode === 'offset') {
          const x = Number(step?.offset?.x || 0);
          const y = Number(step?.offset?.y || 0);
          lines.push(`  await page.evaluate(() => window.scrollTo(${x}, ${y}));`);
        } else if (selector) {
          const x = Number(step?.offset?.x || 0);
          const y = Number(step?.offset?.y || 0);
          lines.push(
            `  await page.locator(${asQuoted(selector)}).evaluate((el) => { el.scrollTo({ left: ${x}, top: ${y} }); });`,
          );
        }
        break;
      case 'wait': {
        const condition = step.condition || {};
        if (condition.selector) {
          lines.push(
            `  await page.waitForSelector(${asQuoted(condition.selector)}, { state: ${asQuoted(
              condition.visible === false ? 'hidden' : 'visible',
            )} });`,
          );
        } else if (condition.text) {
          lines.push(
            `  await expect(page.getByText(${asQuoted(condition.text)})).toBeVisible();`,
          );
        } else if (condition.networkIdle) {
          lines.push(`  await page.waitForLoadState('networkidle');`);
        } else if (condition.navigation) {
          lines.push(`  await page.waitForLoadState('domcontentloaded');`);
        } else if (typeof condition.sleep === 'number') {
          lines.push(`  await page.waitForTimeout(${Math.max(0, Number(condition.sleep))});`);
        }
        break;
      }
      case 'assert': {
        const assert = step.assert || {};
        if (assert.visible) {
          lines.push(`  await expect(page.locator(${asQuoted(assert.visible)})).toBeVisible();`);
        } else if (assert.exists) {
          lines.push(`  await expect(page.locator(${asQuoted(assert.exists)})).toBeAttached();`);
        } else if (assert.textPresent) {
          lines.push(`  await expect(page.getByText(${asQuoted(assert.textPresent)})).toBeVisible();`);
        } else if (assert.attribute && assert.attribute.selector && assert.attribute.name) {
          if (typeof assert.attribute.equals === 'string') {
            lines.push(
              `  await expect(page.locator(${asQuoted(assert.attribute.selector)})).toHaveAttribute(${asQuoted(
                assert.attribute.name,
              )}, ${asQuoted(assert.attribute.equals)});`,
            );
          } else if (typeof assert.attribute.matches === 'string') {
            lines.push(
              `  await expect(page.locator(${asQuoted(assert.attribute.selector)})).toHaveAttribute(${asQuoted(
                assert.attribute.name,
              )}, new RegExp(${asQuoted(assert.attribute.matches)}));`,
            );
          }
        }
        break;
      }
      default:
        lines.push(`  // Unsupported step: ${String(step.type)}`);
        break;
    }
  }
  lines.push('});');
  return lines.join('\n');
}

function buildPuppeteerCode(flow: Flow): string {
  const lines: string[] = [];
  lines.push(`// Generated from flow: ${flow.name}`);
  lines.push(`const puppeteer = require('puppeteer');`);
  lines.push('');
  lines.push(`(async () => {`);
  lines.push(`  const browser = await puppeteer.launch({ headless: false });`);
  lines.push(`  const page = await browser.newPage();`);
  for (const step of toSteps(flow)) {
    const selector = getStepSelector(step);
    switch (step.type) {
      case 'navigate':
        lines.push(`  await page.goto(${asQuoted(step.url || '')}, { waitUntil: 'domcontentloaded' });`);
        break;
      case 'click':
        if (selector) lines.push(`  await page.click(${asQuoted(selector)});`);
        break;
      case 'fill':
        if (selector && typeof step.value !== 'boolean') {
          lines.push(`  await page.type(${asQuoted(selector)}, ${asQuoted(step.value || '')});`);
        }
        break;
      case 'wait': {
        const condition = step.condition || {};
        if (condition.selector) {
          lines.push(`  await page.waitForSelector(${asQuoted(condition.selector)});`);
        } else if (condition.networkIdle) {
          lines.push(`  await page.waitForNetworkIdle();`);
        } else if (typeof condition.sleep === 'number') {
          lines.push(`  await new Promise((r) => setTimeout(r, ${Math.max(0, Number(condition.sleep))}));`);
        }
        break;
      }
      default:
        lines.push(`  // Unsupported step: ${String(step.type)}`);
        break;
    }
  }
  lines.push(`  // await browser.close();`);
  lines.push(`})();`);
  return lines.join('\n');
}

function buildCypressCode(flow: Flow): string {
  const lines: string[] = [];
  lines.push(`// Generated from flow: ${flow.name}`);
  lines.push(`describe(${asQuoted(flow.name)}, () => {`);
  lines.push(`  it('runs flow', () => {`);
  for (const step of toSteps(flow)) {
    const selector = getStepSelector(step);
    switch (step.type) {
      case 'navigate':
        lines.push(`    cy.visit(${asQuoted(step.url || '')});`);
        break;
      case 'click':
        if (selector) lines.push(`    cy.get(${asQuoted(selector)}).click();`);
        break;
      case 'dblclick':
        if (selector) lines.push(`    cy.get(${asQuoted(selector)}).dblclick();`);
        break;
      case 'fill':
        if (selector && typeof step.value !== 'boolean') {
          lines.push(`    cy.get(${asQuoted(selector)}).clear().type(${asQuoted(step.value || '')});`);
        }
        break;
      case 'wait': {
        const condition = step.condition || {};
        if (typeof condition.sleep === 'number') {
          lines.push(`    cy.wait(${Math.max(0, Number(condition.sleep))});`);
        } else if (condition.selector) {
          lines.push(
            `    cy.get(${asQuoted(condition.selector)}).should(${asQuoted(
              condition.visible === false ? 'not.be.visible' : 'be.visible',
            )});`,
          );
        }
        break;
      }
      case 'assert': {
        const assert = step.assert || {};
        if (assert.visible) {
          lines.push(`    cy.get(${asQuoted(assert.visible)}).should('be.visible');`);
        } else if (assert.textPresent) {
          lines.push(`    cy.contains(${asQuoted(assert.textPresent)}).should('be.visible');`);
        }
        break;
      }
      default:
        lines.push(`    // Unsupported step: ${String(step.type)}`);
        break;
    }
  }
  lines.push(`  });`);
  lines.push(`});`);
  return lines.join('\n');
}

class FlowAnalyzeTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_ANALYZE;

  async execute(args: any): Promise<ToolResult> {
    const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    if (!flowId) return createErrorResponse('flowId is required');

    const flow = await getFlow(flowId);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);

    const hints = collectFlowHints(flow);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            summary: {
              flowId: flow.id,
              name: flow.name,
              nodeCount: countFlowNodes(flow),
              edgeCount: Array.isArray(flow.edges) ? flow.edges.length : 0,
              variableCount: Array.isArray(flow.variables) ? flow.variables.length : 0,
              hintCount: hints.length,
            },
            hints,
            flow,
          }),
        },
      ],
      isError: false,
    };
  }
}

class FlowUpdateTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_UPDATE;

  async execute(args: any): Promise<ToolResult> {
    const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    if (!flowId) return createErrorResponse('flowId is required');

    const flow = await getFlow(flowId);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);

    let changed = false;

    if (typeof args?.name === 'string') {
      const nextName = args.name.trim();
      if (nextName && nextName !== flow.name) {
        flow.name = nextName;
        changed = true;
      }
    }
    if (typeof args?.description === 'string') {
      const nextDescription = args.description.trim();
      const normalized = nextDescription || undefined;
      if (normalized !== flow.description) {
        flow.description = normalized;
        changed = true;
      }
    }
    if (Array.isArray(args?.nodes)) {
      flow.nodes = args.nodes;
      changed = true;
    }
    if (Array.isArray(args?.edges)) {
      flow.edges = args.edges;
      changed = true;
    }
    if (Array.isArray(args?.variables)) {
      flow.variables = args.variables;
      changed = true;
    }
    const applyParameterSuggestions = args?.applyParameterSuggestions === true;
    let parameterization: ReturnType<typeof applyFlowParameterSuggestions> | undefined;
    if (applyParameterSuggestions) {
      parameterization = applyFlowParameterSuggestions(flow);
      if (parameterization.changed) {
        changed = true;
      }
    }

    if (!changed) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              updated: false,
              flowId,
              ...(parameterization ? { parameterization } : {}),
            }),
          },
        ],
        isError: false,
      };
    }

    const nowIso = new Date().toISOString();
    if (!flow.meta) {
      flow.meta = { createdAt: nowIso, updatedAt: nowIso };
    } else {
      flow.meta.updatedAt = nowIso;
    }
    await saveFlow(flow);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            updated: true,
            flow: {
              id: flow.id,
              name: flow.name,
              description: flow.description,
              nodeCount: countFlowNodes(flow),
              edgeCount: Array.isArray(flow.edges) ? flow.edges.length : 0,
              variableCount: Array.isArray(flow.variables) ? flow.variables.length : 0,
            },
            ...(parameterization ? { parameterization } : {}),
          }),
        },
      ],
      isError: false,
    };
  }
}

class FlowExportCodeTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_EXPORT_CODE;

  async execute(args: any): Promise<ToolResult> {
    const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    if (!flowId) return createErrorResponse('flowId is required');

    const formatRaw = typeof args?.format === 'string' ? args.format.trim().toLowerCase() : '';
    const format = formatRaw || 'playwright';
    if (!['playwright', 'puppeteer', 'cypress', 'json'].includes(format)) {
      return createErrorResponse(`Unsupported export format: ${format}`);
    }

    const flow = await getFlow(flowId);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);

    let output = '';
    if (format === 'json') {
      output = JSON.stringify(flow, null, 2);
    } else if (format === 'puppeteer') {
      output = buildPuppeteerCode(flow);
    } else if (format === 'cypress') {
      output = buildCypressCode(flow);
    } else {
      output = buildPlaywrightCode(flow);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            flowId: flow.id,
            format,
            code: output,
          }),
        },
      ],
      isError: false,
    };
  }
}

export const flowAnalyzeTool = new FlowAnalyzeTool();
export const flowUpdateTool = new FlowUpdateTool();
export const flowExportCodeTool = new FlowExportCodeTool();
