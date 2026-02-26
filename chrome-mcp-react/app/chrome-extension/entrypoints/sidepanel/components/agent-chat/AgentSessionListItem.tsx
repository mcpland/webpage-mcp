import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSession } from 'webpage-mcp-shared';

type SessionPreviewMeta = {
  displayText?: string;
  clientMeta?: {
    kind?: string;
    elementCount?: number;
  };
};

type SessionWithPreviewMeta = AgentSession & {
  previewMeta?: SessionPreviewMeta;
};

type AgentSessionListItemProps = {
  session: SessionWithPreviewMeta;
  selected?: boolean;
  isRunning?: boolean;
  projectPath?: string;
  onClick?: (sessionId: string) => void;
  onRename?: (sessionId: string, name: string) => void;
  onDelete?: (sessionId: string) => void;
  onOpenProject?: (sessionId: string) => void;
};

function getEngineAbbrev(engineName: string): string {
  switch (engineName) {
    case 'claude':
      return 'CL';
    case 'codex':
      return 'CX';
    case 'cursor':
      return 'CR';
    case 'qwen':
      return 'QW';
    case 'glm':
      return 'GL';
    default:
      return String(engineName || '').slice(0, 2).toUpperCase() || 'AI';
  }
}

function formatUpdatedAt(updatedAt: string): string {
  const date = new Date(updatedAt);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) {
    return 'just now';
  }
  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }
  return date.toLocaleDateString();
}

function formatProjectPath(projectPath?: string): string {
  if (!projectPath) {
    return '';
  }
  if (projectPath.includes('/Users/')) {
    return projectPath.replace(/^\/Users\/[^/]+/, '~');
  }
  if (projectPath.startsWith('/home/')) {
    return projectPath.replace(/^\/home\/[^/]+/, '~');
  }
  return projectPath;
}

export default function AgentSessionListItem({
  session,
  selected,
  isRunning,
  projectPath,
  onClick,
  onRename,
  onDelete,
  onOpenProject,
}: AgentSessionListItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editingName, setEditingName] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setIsEditing(false);
  }, [session.id]);

  useEffect(() => {
    if (isEditing) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [isEditing]);

  const displayName = session.name || 'Unnamed Session';
  const engineAbbrev = getEngineAbbrev(session.engineName);
  const formattedDate = formatUpdatedAt(session.updatedAt);
  const displayProjectPath = formatProjectPath(projectPath);

  const hasPreview = Boolean(session.preview || session.previewMeta);
  const isWebEditorApplyPreview =
    session.previewMeta?.clientMeta?.kind === 'web_editor_apply_batch' ||
    session.previewMeta?.clientMeta?.kind === 'web_editor_apply_single';
  const previewDisplayText = session.previewMeta?.displayText || session.preview || '';
  const previewElementCount = session.previewMeta?.clientMeta?.elementCount;

  const engineBadgeStyle = useMemo(() => {
    const colors: Record<string, string> = {
      claude: '#c87941',
      codex: '#10a37f',
      cursor: '#8b5cf6',
      qwen: '#6366f1',
      glm: '#ef4444',
    };
    const bg = colors[session.engineName] || '#6b7280';
    return {
      backgroundColor: bg,
      color: '#ffffff',
    } as const;
  }, [session.engineName]);

  function confirmRename(): void {
    if (!isEditing) {
      return;
    }

    const trimmed = editingName.trim();
    if (trimmed && trimmed !== session.name) {
      onRename?.(session.id, trimmed);
    }
    setIsEditing(false);
  }

  function handleDelete(): void {
    const sessionName = session.name || session.preview || 'this session';
    if (confirm(`Delete "${sessionName}"?`)) {
      onDelete?.(session.id);
    }
  }

  return (
    <div
      className="group relative px-3 py-3 cursor-pointer transition-colors"
      style={{
        backgroundColor: selected ? 'var(--ac-hover-bg)' : 'transparent',
        borderBottom: 'var(--ac-border-width) solid var(--ac-border)',
      }}
      onClick={() => {
        if (isEditing) {
          return;
        }
        onClick?.(session.id);
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold uppercase"
          style={engineBadgeStyle}
        >
          {engineAbbrev}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            {isEditing ? (
              <input
                ref={renameInputRef}
                value={editingName}
                onChange={(event) => setEditingName(event.currentTarget.value)}
                type="text"
                className="flex-1 px-2 py-0.5 text-sm"
                style={{
                  backgroundColor: 'var(--ac-surface)',
                  border: 'var(--ac-border-width) solid var(--ac-accent)',
                  borderRadius: 'var(--ac-radius-button)',
                  color: 'var(--ac-text)',
                  outline: 'none',
                }}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    confirmRename();
                  }
                  if (event.key === 'Escape') {
                    setIsEditing(false);
                  }
                }}
                onBlur={confirmRename}
              />
            ) : (
              <>
                <span
                  className="text-sm font-medium truncate"
                  style={{ color: selected ? 'var(--ac-accent)' : 'var(--ac-text)' }}
                >
                  {displayName}
                </span>
                {session.model ? (
                  <span
                    className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded"
                    style={{
                      color: 'var(--ac-text-subtle)',
                      backgroundColor: 'var(--ac-surface-muted)',
                      fontFamily: 'var(--ac-font-mono)',
                    }}
                  >
                    {session.model}
                  </span>
                ) : null}
                {isRunning ? (
                  <span
                    className="flex-shrink-0 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide animate-pulse"
                    style={{
                      backgroundColor: 'var(--ac-success)',
                      color: '#ffffff',
                      borderRadius: 'var(--ac-radius-button)',
                    }}
                  >
                    Running
                  </span>
                ) : null}
              </>
            )}
          </div>

          {hasPreview ? (
            <div className="mt-1">
              {isWebEditorApplyPreview ? (
                <div className="flex items-center gap-1 text-xs min-w-0">
                  <span
                    className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded"
                    style={{
                      backgroundColor: 'var(--ac-accent)',
                      color: 'var(--ac-accent-contrast)',
                    }}
                  >
                    <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
                      />
                    </svg>
                  </span>
                  <span className="flex-1 min-w-0 truncate" style={{ color: 'var(--ac-text-muted)' }}>
                    {previewDisplayText}
                  </span>
                  {previewElementCount ? (
                    <span
                      className="flex-shrink-0 px-1 py-0.5 text-[9px] rounded"
                      style={{
                        backgroundColor: 'var(--ac-surface-muted)',
                        color: 'var(--ac-text-muted)',
                      }}
                    >
                      {previewElementCount}
                    </span>
                  ) : null}
                </div>
              ) : (
                <div className="text-xs truncate" style={{ color: 'var(--ac-text-muted)' }}>
                  {session.preview}
                </div>
              )}
            </div>
          ) : null}

          {displayProjectPath ? (
            <div
              className="mt-1 text-[10px] flex items-center gap-1 truncate"
              style={{ color: 'var(--ac-text-subtle)', fontFamily: 'var(--ac-font-mono)' }}
              title={projectPath}
            >
              <svg
                className="w-3 h-3 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                />
              </svg>
              <span className="truncate">{displayProjectPath}</span>
            </div>
          ) : null}
        </div>

        <div className="flex-shrink-0 flex flex-col items-end gap-1">
          <span className="text-[10px]" style={{ color: 'var(--ac-text-subtle)' }}>
            {formattedDate}
          </span>

          <div className="flex items-center gap-1">
            {!isEditing ? (
              <button
                className="p-1.5 rounded-md transition-colors cursor-pointer"
                style={{ color: 'var(--ac-text-muted)', backgroundColor: 'transparent' }}
                title="Open project"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenProject?.(session.id);
                }}
                type="button"
              >
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
                  />
                  <line x1="12" y1="11" x2="12" y2="17" />
                  <line x1="9" y1="14" x2="15" y2="14" />
                </svg>
              </button>
            ) : null}

            {!isEditing ? (
              <button
                className="p-1.5 rounded-md transition-colors cursor-pointer"
                style={{ color: 'var(--ac-text-muted)', backgroundColor: 'transparent' }}
                title="Rename"
                onClick={(event) => {
                  event.stopPropagation();
                  setEditingName(session.name || '');
                  setIsEditing(true);
                }}
                type="button"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                  />
                </svg>
              </button>
            ) : null}

            {!isEditing ? (
              <button
                className="p-1.5 rounded-md transition-colors cursor-pointer"
                style={{ color: 'var(--ac-danger)', backgroundColor: 'transparent' }}
                title="Delete"
                onClick={(event) => {
                  event.stopPropagation();
                  handleDelete();
                }}
                type="button"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
