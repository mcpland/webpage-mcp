import { useEffect, useRef, useState } from 'react';
import type { AgentSession } from 'webpage-mcp-shared';

type AgentSessionMenuProps = {
  open: boolean;
  sessions: AgentSession[];
  selectedSessionId: string;
  isLoading: boolean;
  isCreating: boolean;
  error: string | null;
  onSessionSelect?: (sessionId: string) => void;
  onSessionNew?: () => void;
  onSessionDelete?: (sessionId: string) => void;
  onSessionRename?: (sessionId: string, name: string) => void;
};

function getEngineColor(engineName: string): string {
  const colors: Record<string, string> = {
    claude: '#c87941',
    codex: '#10a37f',
    cursor: '#8b5cf6',
    qwen: '#6366f1',
    glm: '#ef4444',
  };
  return colors[engineName] || '#6b7280';
}

function getSessionDisplayName(session: AgentSession): string {
  if (session.preview) {
    return session.preview;
  }
  if (session.name) {
    return session.name;
  }
  return 'Unnamed Session';
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export default function AgentSessionMenu({
  open,
  sessions,
  selectedSessionId,
  isLoading,
  isCreating,
  error,
  onSessionSelect,
  onSessionNew,
  onSessionDelete,
  onSessionRename,
}: AgentSessionMenuProps) {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingSessionId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [editingSessionId]);

  function handleSessionSelect(sessionId: string): void {
    if (editingSessionId) return;
    onSessionSelect?.(sessionId);
  }

  function handleDeleteSession(sessionId: string): void {
    if (confirm('Delete this session? This cannot be undone.')) {
      onSessionDelete?.(sessionId);
    }
  }

  function startRename(session: AgentSession): void {
    setEditingSessionId(session.id);
    setEditingName(session.name || '');
  }

  function confirmRename(sessionId: string): void {
    const trimmedName = editingName.trim();
    if (trimmedName && editingSessionId === sessionId) {
      onSessionRename?.(sessionId, trimmedName);
    }
    cancelRename();
  }

  function cancelRename(): void {
    setEditingSessionId(null);
    setEditingName('');
  }

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed top-12 left-4 right-4 z-50 py-2 max-w-[calc(100%-2rem)]"
      style={{
        backgroundColor: 'var(--ac-surface, #ffffff)',
        border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
        borderRadius: 'var(--ac-radius-inner, 8px)',
        boxShadow: 'var(--ac-shadow-float, 0 4px 20px -2px rgba(0,0,0,0.1))',
      }}
    >
      <div
        className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider"
        style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}
      >
        Sessions
      </div>

      {isLoading ? (
        <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
          Loading sessions...
        </div>
      ) : null}

      {!isLoading && sessions.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
          No sessions yet
        </div>
      ) : null}

      {!isLoading && sessions.length > 0 ? (
        <div className="max-h-[240px] overflow-y-auto ac-scroll">
          {sessions.map((session) => (
            <div key={session.id} className="group relative">
              <button
                className="w-full px-3 py-2 text-left text-sm flex items-center justify-between ac-menu-item"
                style={{
                  color:
                    selectedSessionId === session.id
                      ? 'var(--ac-accent, #c87941)'
                      : 'var(--ac-text, #1a1a1a)',
                }}
                onClick={() => handleSessionSelect(session.id)}
                type="button"
              >
                <div className="flex-1 min-w-0 pr-16">
                  <div className="truncate flex items-center gap-2">
                    {editingSessionId === session.id ? (
                      <input
                        ref={renameInputRef}
                        value={editingName}
                        onChange={(event) => setEditingName(event.currentTarget.value)}
                        type="text"
                        className="w-full px-1 py-0.5 text-sm"
                        style={{
                          backgroundColor: 'var(--ac-surface, #ffffff)',
                          border: 'var(--ac-border-width, 1px) solid var(--ac-accent, #c87941)',
                          borderRadius: 'var(--ac-radius-button, 8px)',
                          color: 'var(--ac-text, #1a1a1a)',
                          outline: 'none',
                        }}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            confirmRename(session.id);
                          }
                          if (event.key === 'Escape') {
                            cancelRename();
                          }
                        }}
                        onBlur={() => confirmRename(session.id)}
                      />
                    ) : (
                      <>
                        <span>{getSessionDisplayName(session)}</span>
                        <span
                          className="text-[10px] px-1.5 py-0.5"
                          style={{
                            backgroundColor: getEngineColor(session.engineName),
                            color: '#ffffff',
                            borderRadius: 'var(--ac-radius-button, 8px)',
                          }}
                        >
                          {session.engineName}
                        </span>
                      </>
                    )}
                  </div>

                  <div
                    className="text-[10px] truncate flex items-center gap-2"
                    style={{
                      fontFamily: 'var(--ac-font-mono, monospace)',
                      color: 'var(--ac-text-subtle, #a8a29e)',
                    }}
                  >
                    {session.model ? <span>{session.model}</span> : null}
                    <span>{formatDate(session.updatedAt)}</span>
                  </div>
                </div>

                <div className="absolute right-8 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {editingSessionId !== session.id ? (
                    <button
                      className="p-1 ac-btn cursor-pointer"
                      style={{
                        color: 'var(--ac-text-muted, #6e6e6e)',
                        borderRadius: 'var(--ac-radius-button)',
                      }}
                      title="Rename session"
                      onClick={(event) => {
                        event.stopPropagation();
                        startRename(session);
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

                  <button
                    className="p-1 ac-btn cursor-pointer"
                    style={{
                      color: 'var(--ac-danger, #dc2626)',
                      borderRadius: 'var(--ac-radius-button)',
                    }}
                    title="Delete session"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleDeleteSession(session.id);
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
                </div>

                {selectedSessionId === session.id ? (
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                ) : null}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <button
        className="w-full px-3 py-2 text-left text-sm ac-menu-item"
        style={{ color: 'var(--ac-link, #3b82f6)' }}
        disabled={isCreating}
        onClick={onSessionNew}
        type="button"
      >
        {isCreating ? 'Creating...' : '+ New Session'}
      </button>

      {error ? (
        <div className="px-3 py-1 text-[10px]" style={{ color: 'var(--ac-danger, #dc2626)' }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
