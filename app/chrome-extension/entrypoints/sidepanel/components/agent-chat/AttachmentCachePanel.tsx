import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AttachmentCleanupResponse,
  AttachmentStatsResponse,
} from 'webpage-mcp-shared';

type AttachmentCachePanelProps = {
  open: boolean;
  serverPort?: number | null;
  onClose?: () => void;
};

type LoadStatsOptions = {
  resetStatusMessage?: boolean;
};

type AttachmentProjectEntry = AttachmentStatsResponse['projects'][number];

function formatBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const kb = safe / 1024;
  if (kb <= 0) return '0 KB';
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
}

function projectTitle(project: AttachmentProjectEntry): string {
  return project.projectName?.trim() || project.projectId;
}

function isSelectable(project: AttachmentProjectEntry): boolean {
  return project.exists === true && project.fileCount > 0;
}

export default function AttachmentCachePanel({ open, serverPort, onClose }: AttachmentCachePanelProps) {
  const [stats, setStats] = useState<AttachmentStatsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set());
  const statsAbortRef = useRef<AbortController | null>(null);

  const baseUrl = useMemo(() => {
    if (serverPort === null || serverPort === undefined) return null;
    if (!Number.isInteger(serverPort) || serverPort <= 0) return null;
    return `http://127.0.0.1:${serverPort}`;
  }, [serverPort]);

  const serverReady = baseUrl !== null;
  const totalBytes = stats?.totalBytes ?? 0;
  const totalFiles = stats?.totalFiles ?? 0;
  const orphanProjectIds = stats?.orphanProjectIds ?? [];
  const projects: AttachmentProjectEntry[] = stats?.projects ?? [];

  const projectsSorted = useMemo<AttachmentProjectEntry[]>(() => {
    return [...projects].sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0));
  }, [projects]);

  const selectableProjectIds = useMemo(
    () => projectsSorted.filter(isSelectable).map((project) => project.projectId),
    [projectsSorted],
  );

  const selectedCount = selectedProjectIds.size;
  const canClear = serverReady && !isLoading && !isClearing && selectedCount > 0;

  const chipStyle = useMemo(
    () => ({
      backgroundColor: 'var(--ac-chip-bg)',
      color: 'var(--ac-chip-text)',
      border: 'var(--ac-border-width) solid var(--ac-chip-border)',
      borderRadius: 'var(--ac-radius-button)',
      opacity: isClearing ? 0.7 : 1,
    }),
    [isClearing],
  );

  const clearButtonStyle = useMemo(() => {
    if (!canClear) {
      return {
        backgroundColor: 'var(--ac-chip-bg)',
        color: 'var(--ac-text-subtle)',
        border: 'var(--ac-border-width) solid var(--ac-border)',
        borderRadius: 'var(--ac-radius-button)',
        opacity: 0.7,
      };
    }
    return {
      backgroundColor: 'var(--ac-diff-del-bg)',
      color: 'var(--ac-danger)',
      border: 'var(--ac-border-width) solid var(--ac-diff-del-border)',
      borderRadius: 'var(--ac-radius-button)',
    };
  }, [canClear]);

  const isOrphanProject = useCallback(
    (projectId: string): boolean => orphanProjectIds.includes(projectId),
    [orphanProjectIds],
  );

  const isSelected = useCallback(
    (projectId: string): boolean => selectedProjectIds.has(projectId),
    [selectedProjectIds],
  );

  const loadStats = useCallback(
    async (opts: LoadStatsOptions = {}): Promise<void> => {
      const { resetStatusMessage = true } = opts;
      if (!baseUrl) return;

      statsAbortRef.current?.abort();
      const controller = new AbortController();
      statsAbortRef.current = controller;

      setIsLoading(true);
      setErrorMessage(null);
      if (resetStatusMessage) {
        setStatusMessage(null);
      }

      try {
        const response = await fetch(`${baseUrl}/agent/attachments/stats`, { signal: controller.signal });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(text || `HTTP ${response.status}`);
        }

        const data = (await response.json().catch(() => null)) as AttachmentStatsResponse | null;
        if (!data || data.success !== true) {
          throw new Error('Invalid response from server.');
        }

        setStats(data);

        const selectableIds = new Set(data.projects.filter(isSelectable).map((project) => project.projectId));
        setSelectedProjectIds((current) => new Set([...current].filter((id) => selectableIds.has(id))));
      } catch (err: unknown) {
        if ((err as { name?: string }).name === 'AbortError') return;
        console.error('Failed to load attachment stats:', err);
        setErrorMessage(err instanceof Error ? err.message : 'Failed to load attachment stats.');
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    },
    [baseUrl],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!serverReady) return;
    await loadStats();
  }, [loadStats, serverReady]);

  const clearSelected = useCallback(async (): Promise<void> => {
    if (!baseUrl) return;
    const projectIds = [...selectedProjectIds];
    if (projectIds.length === 0) return;

    setIsClearing(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const response = await fetch(`${baseUrl}/agent/attachments`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectIds }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `HTTP ${response.status}`);
      }

      const result = (await response.json().catch(() => null)) as AttachmentCleanupResponse | null;
      if (!result || result.success !== true) {
        throw new Error('Invalid response from server.');
      }

      setStatusMessage(
        `Removed ${formatBytes(result.removedBytes)} (${result.removedFiles.toLocaleString()} files).`,
      );
      setSelectedProjectIds(new Set());
      await loadStats({ resetStatusMessage: false });
    } catch (err: unknown) {
      console.error('Failed to clear attachments:', err);
      setErrorMessage(err instanceof Error ? err.message : 'Failed to clear attachments.');
    } finally {
      setIsClearing(false);
    }
  }, [baseUrl, loadStats, selectedProjectIds]);

  const toggleProject = useCallback((projectId: string): void => {
    setSelectedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((): void => {
    setSelectedProjectIds(new Set(selectableProjectIds));
  }, [selectableProjectIds]);

  const clearSelection = useCallback((): void => {
    setSelectedProjectIds(new Set());
  }, []);

  const invertSelection = useCallback((): void => {
    setSelectedProjectIds((current) => {
      const next = new Set<string>();
      for (const id of selectableProjectIds) {
        if (!current.has(id)) {
          next.add(id);
        }
      }
      return next;
    });
  }, [selectableProjectIds]);

  useEffect(() => {
    if (!open) {
      statsAbortRef.current?.abort();
      setIsLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !baseUrl) return;
    void loadStats();
  }, [open, baseUrl, loadStats]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose?.();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    return () => {
      statsAbortRef.current?.abort();
    };
  }, []);

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Attachment cache management"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose?.();
        }
      }}
    >
      <div className="absolute inset-0 bg-black/40" />

      <div
        className="relative w-full max-w-2xl mx-4 max-h-[85vh] overflow-hidden flex flex-col"
        style={{
          backgroundColor: 'var(--ac-surface, #ffffff)',
          border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
          borderRadius: 'var(--ac-radius-card, 12px)',
          boxShadow: 'var(--ac-shadow-float, 0 4px 20px -2px rgba(0,0,0,0.2))',
        }}
      >
        <div
          className="flex items-start justify-between px-4 py-3 gap-3"
          style={{ borderBottom: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)' }}
        >
          <div className="min-w-0">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--ac-text, #1a1a1a)' }}>
              Attachment Cache
            </h2>
            <p className="text-[10px] mt-0.5" style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}>
              Manage cached images stored on disk by the agent server.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              className="p-1 ac-btn"
              disabled={!serverReady || isLoading || isClearing}
              style={{
                color: 'var(--ac-text-muted, #6e6e6e)',
                borderRadius: 'var(--ac-radius-button, 8px)',
                opacity: !serverReady || isLoading || isClearing ? 0.6 : 1,
              }}
              title="Refresh"
              onClick={() => void refresh()}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M4 4v6h6M20 20v-6h-6M20 8a8 8 0 00-14.828-2M4 16a8 8 0 0014.828 2"
                />
              </svg>
            </button>

            <button
              type="button"
              className="p-1 ac-btn"
              style={{
                color: 'var(--ac-text-muted, #6e6e6e)',
                borderRadius: 'var(--ac-radius-button, 8px)',
              }}
              aria-label="Close"
              onClick={onClose}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto ac-scroll px-4 py-3 space-y-4">
          {!serverReady ? (
            <div className="py-10 text-center">
              <div className="text-sm" style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                Agent server not ready.
              </div>
              <div className="text-[10px] mt-1" style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}>
                Start or reconnect the server, then open this panel again.
              </div>
            </div>
          ) : null}

          {serverReady && isLoading && !stats ? (
            <div className="py-10 text-center">
              <div className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Loading attachment stats...
              </div>
            </div>
          ) : null}

          {serverReady && !isLoading && errorMessage ? (
            <div className="space-y-3">
              <div
                className="px-4 py-3 text-xs rounded-lg"
                style={{
                  backgroundColor: 'var(--ac-diff-del-bg)',
                  color: 'var(--ac-danger)',
                  border: 'var(--ac-border-width) solid var(--ac-diff-del-border)',
                  borderRadius: 'var(--ac-radius-inner)',
                }}
              >
                {errorMessage}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="px-3 py-2 text-xs font-medium cursor-pointer"
                  style={{
                    backgroundColor: 'var(--ac-chip-bg)',
                    color: 'var(--ac-chip-text)',
                    border: 'var(--ac-border-width) solid var(--ac-chip-border)',
                    borderRadius: 'var(--ac-radius-button)',
                  }}
                  disabled={isLoading || isClearing}
                  onClick={() => void refresh()}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="px-3 py-2 text-xs font-medium cursor-pointer"
                  style={{
                    backgroundColor: 'transparent',
                    color: 'var(--ac-text-muted)',
                    borderRadius: 'var(--ac-radius-button)',
                  }}
                  onClick={onClose}
                >
                  Close
                </button>
              </div>
            </div>
          ) : null}

          {serverReady && stats && !errorMessage ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div
                  className="px-3 py-2 rounded-lg"
                  style={{
                    backgroundColor: 'var(--ac-surface-muted)',
                    border: 'var(--ac-border-width) solid var(--ac-border)',
                  }}
                >
                  <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--ac-text-subtle)' }}>
                    Total Size
                  </div>
                  <div className="text-sm font-semibold" style={{ color: 'var(--ac-text)' }}>
                    {formatBytes(totalBytes)}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--ac-text-muted)' }}>
                    {totalFiles.toLocaleString()} files
                  </div>
                </div>

                <div
                  className="px-3 py-2 rounded-lg"
                  style={{
                    backgroundColor: 'var(--ac-surface-muted)',
                    border: 'var(--ac-border-width) solid var(--ac-border)',
                  }}
                >
                  <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--ac-text-subtle)' }}>
                    Root Directory
                  </div>
                  <div className="text-[11px] font-mono truncate" style={{ color: 'var(--ac-text)' }} title={stats.rootDir}>
                    {stats.rootDir || '-'}
                  </div>
                  {orphanProjectIds.length > 0 ? (
                    <div className="text-[10px] mt-0.5" style={{ color: 'var(--ac-text-subtle)' }}>
                      {orphanProjectIds.length} orphan project{orphanProjectIds.length === 1 ? '' : 's'}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div
                  className="text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}
                >
                  Projects
                </div>

                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                  <button
                    type="button"
                    className="px-2 py-1 text-[11px] font-medium cursor-pointer"
                    style={chipStyle}
                    disabled={isClearing || selectableProjectIds.length === 0}
                    onClick={selectAll}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="px-2 py-1 text-[11px] font-medium cursor-pointer"
                    style={chipStyle}
                    disabled={isClearing || selectableProjectIds.length === 0}
                    onClick={invertSelection}
                  >
                    Invert
                  </button>
                  <button
                    type="button"
                    className="px-2 py-1 text-[11px] font-medium cursor-pointer"
                    style={chipStyle}
                    disabled={isClearing || selectedCount === 0}
                    onClick={clearSelection}
                  >
                    Clear
                  </button>
                </div>
              </div>

              {projectsSorted.length === 0 ? (
                <div className="py-8 text-center">
                  <div className="text-sm" style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                    No attachment data found.
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {projectsSorted.map((project) => (
                    <div
                      key={project.projectId}
                      className="flex items-start gap-3 px-3 py-2 rounded-lg"
                      style={{
                        backgroundColor: 'var(--ac-hover-bg-subtle)',
                        border: 'var(--ac-border-width) solid var(--ac-border)',
                        opacity: isClearing ? 0.7 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={isSelected(project.projectId)}
                        disabled={isClearing || !isSelectable(project)}
                        style={{ accentColor: 'var(--ac-accent)' }}
                        onChange={() => toggleProject(project.projectId)}
                      />

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="text-xs font-medium truncate" style={{ color: 'var(--ac-text)' }} title={projectTitle(project)}>
                            {projectTitle(project)}
                          </div>
                          {isOrphanProject(project.projectId) ? (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded"
                              style={{
                                backgroundColor: 'var(--ac-accent-subtle)',
                                color: 'var(--ac-text)',
                              }}
                            >
                              orphan
                            </span>
                          ) : null}
                          {!project.exists ? (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded"
                              style={{
                                backgroundColor: 'var(--ac-chip-bg)',
                                color: 'var(--ac-text-muted)',
                                border: 'var(--ac-border-width) solid var(--ac-chip-border)',
                              }}
                            >
                              missing
                            </span>
                          ) : null}
                        </div>

                        <div className="text-[10px] mt-0.5 flex flex-wrap items-center gap-2" style={{ color: 'var(--ac-text-subtle)' }}>
                          <span>{project.fileCount.toLocaleString()} files</span>
                          <span className="opacity-50">&middot;</span>
                          <span>{formatBytes(project.totalBytes)}</span>
                        </div>
                      </div>

                      <div className="text-right flex-shrink-0">
                        <div className="text-[11px] font-mono" style={{ color: 'var(--ac-text-muted)' }}>
                          {formatBytes(project.totalBytes)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>

        <div
          className="flex-none px-4 py-3 flex items-center justify-between gap-3"
          style={{ borderTop: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)' }}
        >
          <div className="text-[10px] min-w-0" style={{ color: 'var(--ac-text-subtle)' }}>
            {statusMessage ? <span>{statusMessage}</span> : <span>Select projects to remove cached attachment files from disk.</span>}
          </div>

          <button
            type="button"
            className="px-3 py-2 text-xs font-semibold rounded-lg flex-shrink-0 cursor-pointer"
            disabled={!canClear}
            style={clearButtonStyle}
            onClick={() => void clearSelected()}
          >
            {isClearing ? 'Clearing...' : `Clear Selected (${selectedCount})`}
          </button>
        </div>
      </div>
    </div>
  );
}
