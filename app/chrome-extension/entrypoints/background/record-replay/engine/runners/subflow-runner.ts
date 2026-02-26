// subflow-runner.ts — execute a subflow (nodes/edges) using DAG traversal with branch support

import { STEP_TYPES } from 'webpage-mcp-shared';
import type { ExecCtx } from '../../nodes';
import { RunLogger } from '../logging/run-logger';
import { PluginManager } from '../plugins/manager';
import { mapDagNodeToStep } from '../../rr-utils';
import type { Edge, NodeBase, Step } from '../../types';
import { StepRunner } from './step-runner';
import { ENGINE_CONSTANTS } from '../constants';

export interface SubflowEnv {
  runId: string;
  flow: any;
  vars: Record<string, any>;
  logger: RunLogger;
  pluginManager: PluginManager;
  stepRunner: StepRunner;
}

export class SubflowRunner {
  constructor(private env: SubflowEnv) {}

  async runSubflowById(subflowId: string, ctx: ExecCtx, pausedRef: () => boolean): Promise<void> {
    const sub = (this.env.flow.subflows || {})[subflowId];
    if (!sub || !Array.isArray(sub.nodes) || sub.nodes.length === 0) return;

    try {
      await this.env.pluginManager.subflowStart({
        runId: this.env.runId,
        flow: this.env.flow,
        vars: this.env.vars,
        subflowId,
      });
    } catch (e: any) {
      this.env.logger.push({
        stepId: `subflow:${subflowId}`,
        status: 'warning',
        message: `plugin.subflowStart error: ${e?.message || String(e)}`,
      });
    }

    const sNodes: NodeBase[] = sub.nodes;
    const sEdges: Edge[] = sub.edges || [];

    // Build lookup maps
    const id2node = new Map(sNodes.map((n) => [n.id, n] as const));
    const outEdges = new Map<string, Edge[]>();
    for (const e of sEdges) {
      if (!outEdges.has(e.from)) outEdges.set(e.from, []);
      outEdges.get(e.from)!.push(e);
    }

    // Calculate in-degrees to find root nodes
    const indeg = new Map<string, number>(sNodes.map((n) => [n.id, 0] as const));
    for (const e of sEdges) {
      indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    }

    // Find start node: prefer non-trigger nodes with indeg=0
    const findFirstExecutableRoot = (): string | undefined => {
      const executableRoot = sNodes.find(
        (n) => (indeg.get(n.id) || 0) === 0 && n.type !== STEP_TYPES.TRIGGER,
      );
      if (executableRoot) return executableRoot.id;

      // If all roots are triggers, follow default edge to first executable
      const triggerRoot = sNodes.find((n) => (indeg.get(n.id) || 0) === 0);
      if (triggerRoot) {
        const defaultEdge = (outEdges.get(triggerRoot.id) || []).find(
          (e) => !e.label || e.label === ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT,
        );
        if (defaultEdge) return defaultEdge.to;
      }

      return sNodes[0]?.id;
    };

    let currentId: string | undefined = findFirstExecutableRoot();
    let guard = 0;
    const maxIterations = ENGINE_CONSTANTS.MAX_ITERATIONS;

    const ok = (s: Step) => this.env.logger.overlayAppend(`✔ ${s.type} (${s.id})`);
    const fail = (s: Step, e: any) =>
      this.env.logger.overlayAppend(`✘ ${s.type} (${s.id}) -> ${e?.message || String(e)}`);

    while (currentId) {
      if (pausedRef()) break;
      if (guard++ >= maxIterations) {
        this.env.logger.push({
          stepId: `subflow:${subflowId}`,
          status: 'warning',
          message: `Subflow exceeded ${maxIterations} iterations - possible cycle`,
        });
        break;
      }

      const node = id2node.get(currentId);
      if (!node) break;

      // Skip trigger nodes
      if (node.type === STEP_TYPES.TRIGGER) {
        const defaultEdge = (outEdges.get(currentId) || []).find(
          (e) => !e.label || e.label === ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT,
        );
        if (defaultEdge) {
          currentId = defaultEdge.to;
          continue;
        }
        break;
      }

      const step: Step = mapDagNodeToStep(node);
      const r = await this.env.stepRunner.run(ctx, step, ok, fail);

      if (r.status === 'paused' || pausedRef()) break;

      if (r.status === 'failed') {
        // Try to find on_error edge
        const errEdge = (outEdges.get(currentId) || []).find(
          (e) => e.label === ENGINE_CONSTANTS.EDGE_LABELS.ON_ERROR,
        );
        if (errEdge) {
          currentId = errEdge.to;
          continue;
        }
        break;
      }

      // Determine next edge by label
      const suggestedLabel = r.nextLabel
        ? String(r.nextLabel)
        : ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT;
      const oes = outEdges.get(currentId) || [];
      const nextEdge =
        oes.find((e) => (e.label || ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT) === suggestedLabel) ||
        oes.find((e) => !e.label || e.label === ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT);

      if (!nextEdge) {
        // Log warning if we expected a labeled edge but couldn't find it
        if (r.nextLabel && oes.length > 0) {
          const availableLabels = oes.map((e) => e.label || ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT);
          this.env.logger.push({
            stepId: step.id,
            status: 'warning',
            message: `No edge for label '${suggestedLabel}'. Available: [${availableLabels.join(', ')}]`,
          });
        }
        break;
      }
      currentId = nextEdge.to;
    }

    try {
      await this.env.pluginManager.subflowEnd({
        runId: this.env.runId,
        flow: this.env.flow,
        vars: this.env.vars,
        subflowId,
      });
    } catch (e: any) {
      this.env.logger.push({
        stepId: `subflow:${subflowId}`,
        status: 'warning',
        message: `plugin.subflowEnd error: ${e?.message || String(e)}`,
      });
    }
  }
}
