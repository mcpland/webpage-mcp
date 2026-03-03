import { Handle, Position, type NodeProps } from '@xyflow/react';

import type { NodeBase, Edge as EdgeV2 } from '@/entrypoints/background/record-replay/types';
import { getMessage } from '@/utils/i18n';
import { getTypeGlyph, getTypeLabel, nodeSubtitle } from './node-util';

type BuilderNodeData = {
  node: NodeBase;
  edges: EdgeV2[];
  errors?: string[];
};

function readBranches(node: NodeBase): Array<{ id: string; name?: string; expr?: string }> {
  try {
    const branches = (node as any)?.config?.branches;
    if (!Array.isArray(branches)) return [];

    return branches.map((branch: any) => ({
      id: String(branch?.id || ''),
      name: branch?.name,
      expr: branch?.expr,
    }));
  } catch {
    return [];
  }
}

function hasElseCase(node: NodeBase): boolean {
  try {
    return (node as any)?.config?.else !== false;
  } catch {
    return true;
  }
}

export default function NodeIf({ data, selected }: NodeProps) {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);

  const nodeData = data as BuilderNodeData;
  const node = nodeData.node;
  const edges = nodeData.edges || [];

  const subtitle = nodeSubtitle(node);
  const hasIncoming = edges.some((edge) => edge && edge.to === node.id);

  const branches = readBranches(node);
  const hasElse = hasElseCase(node);

  const hasOutgoingLabel = (label: string) =>
    edges.some(
      (edge) =>
        edge && edge.from === node.id && String((edge as any).label || '') === String(label),
    );

  const errList = nodeData.errors || [];
  const hasErrors = errList.length > 0;
  const errorsTitle = errList.join('\n');

  return (
    <div className={`workflow-node ${selected ? 'selected' : ''} type-${node.type}`}>
      {hasErrors ? (
        <div className="node-error" title={errorsTitle}>
          <span aria-hidden>⚠</span>
          <div className="tooltip">
            {errList.map((error) => (
              <div key={error} className="item">
                • {error}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="node-container">
        <div className={`node-icon icon-${node.type}`} aria-hidden>
          {getTypeGlyph(node.type)}
        </div>
        <div className="node-body">
          <div className="node-name">{node.name || getTypeLabel(node.type)}</div>
          <div className="node-subtitle">{subtitle}</div>
        </div>
      </div>

      <div className="if-cases">
        {branches.map((branch, index) => {
          const handleId = `case:${branch.id}`;
          const connected = hasOutgoingLabel(handleId);

          return (
            <div key={handleId} className="case-row">
              <div className="case-label">
                {branch.name ||
                  t('builderIfConditionLabel', 'Condition {0}', [String(index + 1)])}
              </div>
              <Handle
                type="source"
                position={Position.Right}
                id={handleId}
                className={`node-handle ${connected ? 'connected' : 'unconnected'}`}
              />
            </div>
          );
        })}

        {hasElse ? (
          <div className="case-row else-row">
            <div className="case-label">{t('builderIfElseLabel', 'Else')}</div>
            <Handle
              type="source"
              position={Position.Right}
              id="case:else"
              className={`node-handle ${hasOutgoingLabel('case:else') ? 'connected' : 'unconnected'}`}
            />
          </div>
        ) : null}
      </div>

      <Handle
        type="target"
        position={Position.Left}
        className={`node-handle ${hasIncoming ? 'connected' : 'unconnected'}`}
      />
    </div>
  );
}
