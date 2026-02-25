import { useCallback, useEffect } from 'react';
import {
  Background,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { NodeBase, Edge as EdgeV2 } from '@/entrypoints/background/record-replay/types';
import { NODE_UI_LIST, canvasTypeKey } from '@/entrypoints/popup/components/builder/model/ui-nodes';
import { EDGE_LABELS } from 'webpage-mcp-shared';

import NodeCard from './nodes/NodeCard';
import NodeIf from './nodes/NodeIf';
import './Canvas.css';

type BuilderNodeData = {
  node: NodeBase;
  edges: EdgeV2[];
  errors: string[];
};

type CanvasProps = {
  nodes: NodeBase[];
  edges: EdgeV2[];
  nodeErrors?: Record<string, string[]>;
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  focusNodeId?: string | null;
  fitSeq?: number;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
  onDuplicateNode: (id: string) => void;
  onRemoveNode: (id: string) => void;
  onConnectFrom: (id: string, label: 'default' | 'true' | 'false' | 'onError') => void;
  onConnect: (src: string, dst: string, label?: string) => void;
  onNodeDragged: (id: string, x: number, y: number) => void;
  onAddNodeAt: (type: string, x: number, y: number) => void;
};

const nodeTypes = NODE_UI_LIST.reduce<Record<string, unknown>>((result, item) => {
  result[canvasTypeKey(item.type)] = item.type === 'if' ? NodeIf : NodeCard;
  return result;
}, {});

function safeJson(input: unknown): string {
  try {
    return JSON.stringify(input) || '';
  } catch {
    return '';
  }
}

function nodesSignature(props: CanvasProps): string {
  const part = (props.nodes || []).map((node) => {
    const errors = props.nodeErrors?.[node.id] || [];
    const posX = Number((node.ui as any)?.x || 0);
    const posY = Number((node.ui as any)?.y || 0);
    return [
      node.id,
      node.type,
      node.name || '',
      String(posX),
      String(posY),
      safeJson((node as any).config || {}),
      errors.join('\\u0001'),
    ].join('\\u0002');
  });

  return `${part.join('\\u0003')}|selected:${props.selectedNodeId || ''}`;
}

function edgesSignature(props: CanvasProps): string {
  const part = (props.edges || []).map((edge) =>
    [edge.id, edge.from, edge.to, String((edge as any).label || '')].join('\\u0002'),
  );

  return `${part.join('\\u0003')}|selected:${props.selectedEdgeId || ''}`;
}

function buildNodes(props: CanvasProps): Array<Node<BuilderNodeData>> {
  const list = props.nodes || [];
  const edgesRef = props.edges || [];

  return list.map((node) => ({
    id: node.id,
    position: { x: Number((node.ui as any)?.x || 0), y: Number((node.ui as any)?.y || 0) },
    type: canvasTypeKey(node.type as any),
    selected: props.selectedNodeId === node.id,
    data: {
      node,
      edges: edgesRef,
      errors: (props.nodeErrors || {})[node.id] || [],
    },
    className: 'rr-node-plain',
  }));
}

function buildEdges(props: CanvasProps): Edge[] {
  const list = props.edges || [];

  const textFor = (label?: string) => {
    const normalized = label || 'default';
    if (normalized === EDGE_LABELS.TRUE) return '✓';
    if (normalized === EDGE_LABELS.FALSE) return '✗';
    if (normalized === EDGE_LABELS.ON_ERROR) return '!';
    return '';
  };

  const labelFor = (edge: EdgeV2) => {
    const raw = String((edge as any)?.label || '');
    if (raw.startsWith('case:')) return '';
    if (raw === 'else') return '';
    return textFor(raw);
  };

  return list.map((edge) => {
    const rawLabel = String((edge as any)?.label || '');

    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      sourceHandle: rawLabel.startsWith('case:') ? rawLabel : undefined,
      selected: props.selectedEdgeId === edge.id,
      label: labelFor(edge),
      labelBgPadding: [4, 6],
      labelBgStyle: {
        fill: '#e5e5e5',
        fillOpacity: 0.95,
        stroke: '#ffffff',
        strokeWidth: 1,
      },
      labelStyle: {
        fill: '#666666',
        fontWeight: 600,
        fontSize: 11,
      },
      style: {
        stroke: '#cdcdcd',
        strokeWidth: 1.5,
      },
      animated: false,
      type: 'bezier',
    } as Edge;
  });
}

function BuilderCanvasInner(props: CanvasProps) {
  const [vfNodes, setVfNodes, onNodesChange] = useNodesState<BuilderNodeData>([]);
  const [vfEdges, setVfEdges, onEdgesChange] = useEdgesState([]);
  const { fitView, getNode, screenToFlowPosition } = useReactFlow<BuilderNodeData>();

  const currentNodesSig = nodesSignature(props);
  const currentEdgesSig = edgesSignature(props);

  useEffect(() => {
    setVfNodes(buildNodes(props));
  }, [currentNodesSig, currentEdgesSig, props, setVfNodes]);

  useEffect(() => {
    setVfEdges(buildEdges(props));
  }, [currentEdgesSig, props, setVfEdges]);

  useEffect(() => {
    if (!props.focusNodeId) return;
    const node = getNode(props.focusNodeId);
    if (!node) return;

    try {
      fitView({ nodes: [node], duration: 300, padding: 0.2 });
    } catch {
      // ignore
    }
  }, [props.focusNodeId, currentNodesSig, fitView, getNode]);

  useEffect(() => {
    try {
      fitView({ duration: 300, padding: 0.2 });
    } catch {
      // ignore
    }
  }, [props.fitSeq, fitView]);

  const onNodeDragStopInternal = useCallback(
    (_event: unknown, node: Node<BuilderNodeData>) => {
      props.onNodeDragged(node.id, Math.round(node.position.x), Math.round(node.position.y));
    },
    [props],
  );

  const onConnectInternal = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const label = String(connection.sourceHandle || 'default');
      props.onConnect(connection.source, connection.target, label);
    },
    [props],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    try {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    } catch {
      // ignore
    }
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      try {
        event.preventDefault();
      } catch {
        // ignore
      }

      const type = (
        event.dataTransfer?.getData('application/node-type') ||
        event.dataTransfer?.getData('text/node-type') ||
        event.dataTransfer?.getData('text/plain') ||
        ''
      ).trim();

      if (!type) return;

      try {
        const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
        props.onAddNodeAt(type, Math.round(position.x || 0), Math.round(position.y || 0));
      } catch {
        props.onAddNodeAt(type, 200, 120);
      }
    },
    [props, screenToFlowPosition],
  );

  const onPaneClick = useCallback(() => {
    props.onSelectNode(null);
    props.onSelectEdge(null);
  }, [props]);

  const onEdgeClick = useCallback(
    (_event: unknown, edge: Edge) => {
      props.onSelectNode(null);
      props.onSelectEdge(edge?.id ? String(edge.id) : null);
    },
    [props],
  );

  const onNodeClick = useCallback(
    (_event: unknown, node: Node<BuilderNodeData>) => {
      props.onSelectEdge(null);
      props.onSelectNode(node?.id ? String(node.id) : null);
    },
    [props],
  );

  return (
    <ReactFlow
      nodes={vfNodes}
      edges={vfEdges}
      nodeTypes={nodeTypes}
      minZoom={0.2}
      maxZoom={1.5}
      fitView
      snapToGrid
      snapGrid={[24, 24]}
      onConnect={onConnectInternal}
      onNodeDragStop={onNodeDragStopInternal}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPaneClick={onPaneClick}
      onEdgeClick={onEdgeClick}
      onNodeClick={onNodeClick}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      proOptions={{ hideAttribution: true }}
    >
      <Background color="#cdcdcd" gap={32} />
    </ReactFlow>
  );
}

export default function BuilderCanvas(props: CanvasProps) {
  return (
    <section className="canvas rr-dot-grid">
      <ReactFlowProvider>
        <BuilderCanvasInner {...props} />
      </ReactFlowProvider>
    </section>
  );
}
