import { useMemo, useState } from 'react';
import type { AgentProject, AgentSession } from 'webpage-mcp-shared';

import AgentSessionListItem from './AgentSessionListItem';

type SessionWithPreviewMeta = AgentSession & {
  previewMeta?: {
    displayText?: string;
    clientMeta?: {
      kind?: string;
      elementCount?: number;
    };
  };
};

type AgentSessionsViewProps = {
  sessions: SessionWithPreviewMeta[];
  selectedSessionId: string;
  isLoading: boolean;
  isCreating: boolean;
  error: string | null;
  runningSessionIds?: Set<string>;
  projectsMap?: Map<string, AgentProject>;
  onSessionSelect?: (sessionId: string) => void;
  onSessionNew?: () => void;
  onSessionDelete?: (sessionId: string) => void;
  onSessionRename?: (sessionId: string, name: string) => void;
  onSessionOpenProject?: (sessionId: string) => void;
};

export default function AgentSessionsView({
  sessions,
  selectedSessionId,
  isLoading,
  isCreating,
  error,
  runningSessionIds,
  projectsMap,
  onSessionSelect,
  onSessionNew,
  onSessionDelete,
  onSessionRename,
  onSessionOpenProject,
}: AgentSessionsViewProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredSessions = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) {
      return [...sessions].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    }

    return sessions
      .filter((session) => {
        const searchFields = [
          session.name || '',
          session.preview || '',
          session.model || '',
          session.engineName || '',
        ]
          .join(' ')
          .toLowerCase();

        return searchFields.includes(query);
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [searchQuery, sessions]);

  function isSessionRunning(sessionId: string): boolean {
    return runningSessionIds?.has(sessionId) ?? false;
  }

  function getProjectPath(session: AgentSession): string | undefined {
    return projectsMap?.get(session.projectId)?.rootPath;
  }

  return (
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--ac-surface)' }}>
      <div
        className="flex-shrink-0 px-4 py-3 border-b"
        style={{
          borderColor: 'var(--ac-border)',
          backgroundColor: 'var(--ac-surface)',
        }}
      >
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
              style={{ color: 'var(--ac-text-subtle)' }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              type="text"
              placeholder="Search sessions..."
              className="w-full pl-9 pr-3 py-2 text-sm"
              style={{
                backgroundColor: 'var(--ac-surface-muted)',
                border: 'var(--ac-border-width) solid var(--ac-border)',
                borderRadius: 'var(--ac-radius-button)',
                color: 'var(--ac-text)',
                outline: 'none',
              }}
            />
          </div>

          <button
            className="flex-shrink-0 px-3 py-2 text-sm font-medium cursor-pointer"
            style={{
              backgroundColor: 'var(--ac-accent)',
              color: 'var(--ac-accent-contrast)',
              borderRadius: 'var(--ac-radius-button)',
            }}
            disabled={isCreating}
            onClick={onSessionNew}
            type="button"
          >
            {isCreating ? (
              <span>Creating...</span>
            ) : (
              <span className="flex items-center gap-1">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                </svg>
                New
              </span>
            )}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto ac-scroll">
        {isLoading ? (
          <div
            className="flex items-center justify-center py-12"
            style={{ color: 'var(--ac-text-muted)' }}
          >
            <span className="text-sm">Loading sessions...</span>
          </div>
        ) : null}

        {!isLoading && filteredSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
              style={{ backgroundColor: 'var(--ac-surface-muted)' }}
            >
              <svg
                className="w-8 h-8"
                style={{ color: 'var(--ac-text-subtle)' }}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                />
              </svg>
            </div>
            <div className="text-sm font-medium mb-1" style={{ color: 'var(--ac-text)' }}>
              {searchQuery ? 'No matching sessions' : 'No sessions yet'}
            </div>
            <div className="text-xs text-center mb-4" style={{ color: 'var(--ac-text-muted)' }}>
              {searchQuery ? 'Try a different search term' : 'Start a new conversation with AI'}
            </div>
            {!searchQuery ? (
              <button
                className="px-4 py-2 text-sm font-medium cursor-pointer"
                style={{
                  backgroundColor: 'var(--ac-accent)',
                  color: 'var(--ac-accent-contrast)',
                  borderRadius: 'var(--ac-radius-button)',
                }}
                onClick={onSessionNew}
                type="button"
              >
                Start New Session
              </button>
            ) : null}
          </div>
        ) : null}

        {!isLoading && filteredSessions.length > 0 ? (
          <div>
            {filteredSessions.map((session) => (
              <AgentSessionListItem
                key={session.id}
                session={session}
                projectPath={getProjectPath(session)}
                selected={selectedSessionId === session.id}
                isRunning={isSessionRunning(session.id)}
                onClick={onSessionSelect}
                onRename={onSessionRename}
                onDelete={onSessionDelete}
                onOpenProject={onSessionOpenProject}
              />
            ))}
          </div>
        ) : null}
      </div>

      {error ? (
        <div
          className="flex-shrink-0 px-4 py-2 text-xs"
          style={{ color: 'var(--ac-danger)', backgroundColor: 'var(--ac-surface-muted)' }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
