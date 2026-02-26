import type { NodeBase } from '@/entrypoints/background/record-replay/types';
import { validateNodeWithRegistry } from '@/entrypoints/popup/components/builder/model/ui-nodes';
import PropertyFromSpec from '@/entrypoints/popup/components/builder/components/properties/PropertyFromSpec';
import './PropertyPanel.css';

type BuilderVariable = { key: string; origin?: string; nodeId?: string; nodeName?: string };

type PropertyPanelProps = {
  node: NodeBase | null;
  highlightField?: string | null;
  subflowIds?: string[];
  variables?: BuilderVariable[];
  onCreateSubflow: (id: string) => void;
  onSwitchToSubflow: (id: string) => void;
  onRemoveNode: (id: string) => void;
};

export default function PropertyPanel({ node, variables, onRemoveNode }: PropertyPanelProps) {
  const nodeErrors = node ? validateNodeWithRegistry(node) : [];

  function onRemove() {
    if (!node) return;
    onRemoveNode(node.id);
  }

  function onTimeoutChange(value: string) {
    if (!node) return;
    const n = node as any;
    if (!n.config) n.config = {};
    const parsed = Number(value);
    n.config.timeoutMs = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  function onScreenshotOnFailChange(checked: boolean) {
    if (!node) return;
    const n = node as any;
    if (!n.config) n.config = {};
    n.config.screenshotOnFail = checked;
  }

  return (
    <aside className="property-panel">
      {node ? (
        <div className="panel-content">
          <div className="panel-header">
            <div>
              <div className="header-title">Node properties</div>
              <div className="header-id">{node.id}</div>
            </div>
            <button className="btn-delete" type="button" title="Delete node" onClick={onRemove}>
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

          <div className="form-section">
            <div className="form-group">
              <label className="form-label">Node name</label>
              <input
                className="form-input"
                value={node.name || ''}
                onChange={(event) => {
                  node.name = event.currentTarget.value;
                }}
                placeholder="Enter node name"
              />
            </div>
          </div>

          <div className="divider" />

          <PropertyFromSpec key={`${node.type}:${node.id}`} node={node} variables={variables} />

          <div className="divider" />

          <div className="form-section">
            <div className="section-title">General settings</div>
            <div className="form-group">
              <label className="form-label">Timeout (ms)</label>
              <input
                className="form-input"
                type="number"
                min="0"
                value={String((node.config as any)?.timeoutMs ?? '')}
                onChange={(event) => onTimeoutChange(event.currentTarget.value)}
                placeholder="Use global timeout by default"
              />
            </div>
            <div className="form-group checkbox-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={!!(node.config as any)?.screenshotOnFail}
                  onChange={(event) => onScreenshotOnFailChange(event.currentTarget.checked)}
                />
                <span>Screenshot on failure</span>
              </label>
            </div>
          </div>

          {nodeErrors.length > 0 ? (
            <div className="error-box">
              <div className="error-title">⚠️ Configuration error</div>
              {nodeErrors.map((error) => (
                <div key={error} className="error-item">
                  {error}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="panel-empty">
          <svg className="empty-icon" width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect
              x="8"
              y="8"
              width="32"
              height="32"
              rx="4"
              stroke="currentColor"
              strokeWidth="2"
              opacity="0.3"
            />
            <path
              d="M18 20h12M18 24h12M18 28h8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              opacity="0.3"
            />
          </svg>
          <div className="empty-text">
            Select a node
            <br />
            View and edit properties
          </div>
        </div>
      )}
    </aside>
  );
}
