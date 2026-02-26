import { Handle, Position, type NodeProps } from '@xyflow/react';

import type { NodeBase, Edge as EdgeV2 } from '@/entrypoints/background/record-replay/types';
import { getTypeGlyph, getTypeLabel, nodeSubtitle } from './node-util';

type BuilderNodeData = {
  node: NodeBase;
  edges: EdgeV2[];
  errors?: string[];
};

export default function NodeCard({ data, selected }: NodeProps) {
  const nodeData = data as BuilderNodeData;
  const node = nodeData.node;
  const edges = nodeData.edges || [];

  const subtitle = nodeSubtitle(node);
  const hasIncoming = edges.some((edge) => edge && edge.to === node.id);
  const hasOutgoing = edges.some((edge) => edge && edge.from === node.id);

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

      {node.type !== 'trigger' ? (
        <Handle
          type="target"
          position={Position.Left}
          className={`node-handle ${hasIncoming ? 'connected' : 'unconnected'}`}
        />
      ) : null}

      {node.type !== 'if' ? (
        <Handle
          type="source"
          position={Position.Right}
          className={`node-handle ${hasOutgoing ? 'connected' : 'unconnected'}`}
        />
      ) : null}
    </div>
  );
}
