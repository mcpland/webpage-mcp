import { type CSSProperties, useEffect, useState } from 'react';
import './WorkflowListItem.css';

export interface WorkflowFlowLite {
  id: string;
  name: string;
  description?: string;
  meta?: {
    domain?: string;
    tags?: string[];
    bindings?: unknown[];
  };
}

export type WorkflowListItemProps = {
  flow: WorkflowFlowLite;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
};

const itemStyle: CSSProperties = {
  backgroundColor: 'var(--ac-surface, #ffffff)',
  borderRadius: 'var(--ac-radius-card, 12px)',
  border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4)',
  transition: 'all var(--ac-motion-fast, 120ms) ease',
};

const nameStyle: CSSProperties = {
  color: 'var(--ac-text, #1a1a1a)',
};

const descStyle: CSSProperties = {
  color: 'var(--ac-text-muted, #6e6e6e)',
};

const tagDomainStyle: CSSProperties = {
  backgroundColor: 'var(--ac-accent-subtle, rgba(217, 119, 87, 0.12))',
  color: 'var(--ac-accent, #d97757)',
};

const tagStyle: CSSProperties = {
  backgroundColor: 'var(--ac-surface-muted, #f2f0eb)',
  color: 'var(--ac-text-muted, #6e6e6e)',
};

const actionStyle: CSSProperties = {
  backgroundColor: 'var(--ac-surface-muted, #f2f0eb)',
  color: 'var(--ac-text-muted, #6e6e6e)',
  borderRadius: 'var(--ac-radius-button, 8px)',
};

const actionPrimaryStyle: CSSProperties = {
  backgroundColor: 'var(--ac-accent, #d97757)',
  color: 'var(--ac-accent-contrast, #ffffff)',
  borderRadius: 'var(--ac-radius-button, 8px)',
};

const menuStyle: CSSProperties = {
  backgroundColor: 'var(--ac-surface, #ffffff)',
  border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4)',
  borderRadius: 'var(--ac-radius-inner, 8px)',
  boxShadow: 'var(--ac-shadow-float, 0 4px 20px -2px rgba(0, 0, 0, 0.1))',
};

const menuItemStyle: CSSProperties = {
  color: 'var(--ac-text, #1a1a1a)',
};

const menuItemDangerStyle: CSSProperties = {
  color: 'var(--ac-danger, #ef4444)',
};

export default function WorkflowListItem({
  flow,
  onRun,
  onEdit,
  onDelete,
  onExport,
}: WorkflowListItemProps) {
  const [showActions, setShowActions] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  const hasTags = Boolean(flow.meta?.domain || (flow.meta?.tags?.length ?? 0) > 0);

  useEffect(() => {
    const handleClickOutside = () => {
      if (showMoreMenu) {
        setShowMoreMenu(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [showMoreMenu]);

  return (
    <div
      className="workflow-item"
      style={itemStyle}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div className="workflow-content">
        <div className="workflow-info">
          <div className="workflow-name" style={nameStyle}>
            {flow.name || 'Untitled'}
          </div>
          <div className="workflow-desc" style={descStyle}>
            {flow.description || 'No description'}
          </div>

          {hasTags ? (
            <div className="workflow-tags">
              {flow.meta?.domain ? (
                <span className="workflow-tag" style={tagDomainStyle}>
                  {flow.meta.domain}
                </span>
              ) : null}

              {(flow.meta?.tags || []).map((tag) => (
                <span key={tag} className="workflow-tag" style={tagStyle}>
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className={`workflow-actions${showActions ? ' workflow-actions-visible' : ''}`}>
          <button
            className="workflow-action workflow-action-primary"
            style={actionPrimaryStyle}
            onClick={(event) => {
              event.stopPropagation();
              onRun(flow.id);
            }}
            title="Run workflow"
            type="button"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>

          <button
            className="workflow-action"
            style={actionStyle}
            onClick={(event) => {
              event.stopPropagation();
              onEdit(flow.id);
            }}
            title="Edit workflow"
            type="button"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </button>

          <button
            className="workflow-action workflow-action-more"
            style={actionStyle}
            onClick={(event) => {
              event.stopPropagation();
              setShowMoreMenu((current) => !current);
            }}
            title="More actions"
            type="button"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>

          {showMoreMenu ? (
            <div className="workflow-more-menu" style={menuStyle} onClick={(event) => event.stopPropagation()}>
              <button
                className="workflow-menu-item"
                style={menuItemStyle}
                onClick={() => {
                  setShowMoreMenu(false);
                  onExport(flow.id);
                }}
                type="button"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                  />
                </svg>
                <span>Export</span>
              </button>

              <button
                className="workflow-menu-item workflow-menu-item-danger"
                style={menuItemDangerStyle}
                onClick={() => {
                  setShowMoreMenu(false);
                  onDelete(flow.id);
                }}
                type="button"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
                <span>Delete</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
