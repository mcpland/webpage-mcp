import type { Edge as EdgeV2, NodeBase } from '@/entrypoints/background/record-replay/types';
import './EdgePropertyPanel.css';

type EdgePropertyPanelProps = {
  edge: EdgeV2 | null;
  nodes: NodeBase[];
  onRemoveEdge: (id: string) => void;
};

export default function EdgePropertyPanel({ edge, nodes, onRemoveEdge }: EdgePropertyPanelProps) {
  const src = nodes?.find?.((n) => n.id === (edge as any)?.from) || null;
  const dst = nodes?.find?.((n) => n.id === (edge as any)?.to) || null;

  const srcName = src ? src.name || `${src.type} (${src.id})` : 'Unknown';
  const dstName = dst ? dst.name || `${dst.type} (${dst.id})` : 'Unknown';
  const isValid = !!(src && dst && src.id !== dst.id);

  const raw = String((edge as any)?.label || 'default');
  let labelPretty = raw;
  if (raw === 'default') labelPretty = 'default';
  else if (raw === 'true') labelPretty = 'true ✓';
  else if (raw === 'false') labelPretty = 'false ✗';
  else if (raw === 'onError') labelPretty = 'onError !';
  else if (raw === 'else') labelPretty = 'else';
  else if (raw.startsWith('case:')) {
    const id = raw.slice('case:'.length);
    const ifNode = src && (src as any).type === 'if' ? (src as any) : null;
    const found = ifNode?.config?.branches?.find?.((b: any) => String(b.id) === id);
    labelPretty = found ? `case: ${found.name || found.expr || id}` : `case: ${id}`;
  }

  function onRemove() {
    if (!edge) return;
    onRemoveEdge(edge.id);
  }

  return (
    <aside className="builder-edge-property-panel">
      {edge ? (
        <div className="builder-edge-property-panel__content">
          <div className="builder-edge-property-panel__header">
            <div>
              <div className="builder-edge-property-panel__header-title">Edge</div>
              <div className="builder-edge-property-panel__header-id">{edge.id}</div>
            </div>
            <button
              className="builder-edge-property-panel__btn-delete"
              type="button"
              title="删除边"
              onClick={onRemove}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="m4 4 8 8M12 4 4 12"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <div className="builder-edge-property-panel__section">
            <div className="builder-edge-property-panel__group">
              <label className="builder-edge-property-panel__label">Source</label>
              <div className="builder-edge-property-panel__text">{srcName}</div>
            </div>
            <div className="builder-edge-property-panel__group">
              <label className="builder-edge-property-panel__label">Target</label>
              <div className="builder-edge-property-panel__text">{dstName}</div>
            </div>
            <div className="builder-edge-property-panel__group">
              <label className="builder-edge-property-panel__label">Connection status</label>
              <div
                className={
                  isValid
                    ? 'builder-edge-property-panel__status builder-edge-property-panel__status--ok'
                    : 'builder-edge-property-panel__status builder-edge-property-panel__status--bad'
                }
              >
                {isValid ? 'Valid' : 'Invalid'}
              </div>
            </div>
            <div className="builder-edge-property-panel__group">
              <label className="builder-edge-property-panel__label">Branch</label>
              <div className="builder-edge-property-panel__text">{labelPretty}</div>
            </div>
          </div>

          <div className="builder-edge-property-panel__divider" />

          <div className="builder-edge-property-panel__section">
            <div className="builder-edge-property-panel__helper-text">
              Inspect connection only. Editing of branch/handles will be supported in a later pass.
            </div>
          </div>
        </div>
      ) : (
        <div className="builder-edge-property-panel__empty">
          <div className="builder-edge-property-panel__empty-text">未选择边</div>
        </div>
      )}
    </aside>
  );
}
