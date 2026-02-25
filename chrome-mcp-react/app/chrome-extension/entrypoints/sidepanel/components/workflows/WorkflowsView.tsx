import { type CSSProperties, useMemo, useState } from 'react';

import WorkflowListItem, { type WorkflowFlowLite } from './WorkflowListItem';
import './WorkflowsView.css';

export interface FlowLite extends WorkflowFlowLite {}

export interface RunLite {
  id: string;
  flowId: string;
  startedAt: string;
  finishedAt?: string;
  success?: boolean;
  isInProgress?: boolean;
  status?: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'canceled';
  entries: Array<{
    status?: string;
    stepId?: string;
    tookMs?: number;
  }>;
}

export interface TriggerLite {
  id: string;
  type: string;
  flowId: string;
  enabled?: boolean;
}

export type WorkflowsViewProps = {
  flows: FlowLite[];
  runs: RunLite[];
  triggers: TriggerLite[];
  onlyBound: boolean;
  openRunId: string | null;
  onRefresh: () => void;
  onCreate: () => void;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onOnlyBoundChange: (value: boolean) => void;
  onToggleRun: (id: string) => void;
  onCreateTrigger: () => void;
  onEditTrigger: (id: string) => void;
  onRemoveTrigger: (id: string) => void;
};

const containerStyle: CSSProperties = {
  backgroundColor: 'var(--ac-surface)',
};

const headerStyle: CSSProperties = {
  borderColor: 'var(--ac-border)',
  backgroundColor: 'var(--ac-surface)',
};

const inputStyle: CSSProperties = {
  backgroundColor: 'var(--ac-surface-muted)',
  border: 'var(--ac-border-width) solid var(--ac-border)',
  borderRadius: 'var(--ac-radius-button)',
  color: 'var(--ac-text)',
  outline: 'none',
};

const refreshButtonStyle: CSSProperties = {
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text-muted)',
  borderRadius: 'var(--ac-radius-button)',
  border: 'none',
};

const newButtonStyle: CSSProperties = {
  backgroundColor: 'var(--ac-accent)',
  color: 'var(--ac-accent-contrast)',
  borderRadius: 'var(--ac-radius-button)',
};

const dividerStyle: CSSProperties = {
  borderColor: 'var(--ac-border)',
};

const sectionStyle: CSSProperties = {
  backgroundColor: 'var(--ac-surface)',
  border: 'var(--ac-border-width) solid var(--ac-border)',
  borderRadius: 'var(--ac-radius-inner)',
};

const sectionHeaderStyle: CSSProperties = {
  color: 'var(--ac-text)',
};

const runItemStyle: CSSProperties = {
  backgroundColor: 'var(--ac-surface-muted)',
  borderRadius: 'var(--ac-radius-button)',
};

const triggerItemStyle: CSSProperties = {
  backgroundColor: 'var(--ac-surface-muted)',
  borderRadius: 'var(--ac-radius-button)',
};

const triggerAddStyle: CSSProperties = {
  backgroundColor: 'var(--ac-accent-subtle)',
  color: 'var(--ac-accent)',
  borderRadius: '50%',
};

const triggerActionStyle: CSSProperties = {
  color: 'var(--ac-text-muted)',
};

const triggerActionDangerStyle: CSSProperties = {
  color: 'var(--ac-danger)',
};

export default function WorkflowsView({
  flows,
  runs,
  triggers,
  onlyBound,
  openRunId,
  onRefresh,
  onCreate,
  onRun,
  onEdit,
  onDelete,
  onExport,
  onOnlyBoundChange,
  onToggleRun,
  onCreateTrigger,
  onEditTrigger,
  onRemoveTrigger,
}: WorkflowsViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  const filteredFlows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return flows;
    }

    return flows.filter((flow) => {
      const name = (flow.name || '').toLowerCase();
      const desc = (flow.description || '').toLowerCase();
      const domain = (flow.meta?.domain || '').toLowerCase();
      const tags = (flow.meta?.tags || []).join(' ').toLowerCase();
      return (
        name.includes(query) || desc.includes(query) || domain.includes(query) || tags.includes(query)
      );
    });
  }, [flows, searchQuery]);

  function getFlowName(flowId: string): string {
    const flow = flows.find((item) => item.id === flowId);
    return flow?.name || flowId;
  }

  function getRunStatusColor(run: RunLite): string {
    if (run.isInProgress) {
      return 'var(--ac-primary, #3b82f6)';
    }

    if (run.status) {
      if (run.status === 'succeeded') return 'var(--ac-success, #22c55e)';
      if (run.status === 'failed' || run.status === 'canceled') return 'var(--ac-danger, #ef4444)';
      return 'var(--ac-primary, #3b82f6)';
    }

    return run.success ? 'var(--ac-success, #22c55e)' : 'var(--ac-danger, #ef4444)';
  }

  function getRunStatusText(run: RunLite): string {
    if (run.status) {
      const statusMap: Record<string, string> = {
        queued: '排队中',
        running: '运行中',
        paused: '已暂停',
        succeeded: '成功',
        failed: '失败',
        canceled: '已取消',
      };
      return statusMap[run.status] || run.status;
    }
    return run.success ? '成功' : '失败';
  }

  function formatTime(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleString();
  }

  function toggleSection(section: string): void {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }

  return (
    <div className="h-full flex flex-col" style={containerStyle}>
      <div className="flex-shrink-0 px-4 py-3 border-b" style={headerStyle}>
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
              placeholder="Search workflows..."
              className="w-full pl-9 pr-3 py-2 text-sm"
              style={inputStyle}
            />
          </div>

          <button className="flex-shrink-0 p-2" style={refreshButtonStyle} onClick={onRefresh} title="Refresh" type="button">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>

          <button className="flex-shrink-0 px-3 py-2 text-sm font-medium" style={newButtonStyle} onClick={onCreate} type="button">
            <span className="flex items-center gap-1">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              New
            </span>
          </button>
        </div>

        <div className="flex items-center justify-between mt-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--ac-text-muted)' }}>
            <input
              type="checkbox"
              checked={onlyBound}
              onChange={(event) => onOnlyBoundChange(event.currentTarget.checked)}
              className="workflow-checkbox"
            />
            <span>Current page only</span>
          </label>

          <span className="text-xs" style={{ color: 'var(--ac-text-subtle)' }}>
            {filteredFlows.length} workflow{filteredFlows.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto ac-scroll">
        {filteredFlows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4" style={{ backgroundColor: 'var(--ac-surface-muted)' }}>
              <svg className="w-8 h-8" style={{ color: 'var(--ac-text-subtle)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                  d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
                />
              </svg>
            </div>
            <div className="text-sm font-medium mb-1" style={{ color: 'var(--ac-text)' }}>
              {searchQuery ? 'No matching workflows' : 'No workflows yet'}
            </div>
            <div className="text-xs text-center mb-4" style={{ color: 'var(--ac-text-muted)' }}>
              {searchQuery ? 'Try a different search term' : 'Record your first automation workflow'}
            </div>
            {!searchQuery ? (
              <button className="px-4 py-2 text-sm font-medium" style={newButtonStyle} onClick={onCreate} type="button">
                Create Workflow
              </button>
            ) : null}
          </div>
        ) : (
          <div className="px-4 py-3 space-y-3">
            {filteredFlows.map((flow) => (
              <WorkflowListItem
                key={flow.id}
                flow={flow}
                onRun={onRun}
                onEdit={onEdit}
                onDelete={onDelete}
                onExport={onExport}
              />
            ))}
          </div>
        )}

        <div className="px-4 pb-4">
          <div className="advanced-divider" style={dividerStyle}>
            <span
              style={{
                backgroundColor: 'var(--ac-surface)',
                padding: '0 12px',
                color: 'var(--ac-text-subtle)',
              }}
            >
              Advanced
            </span>
          </div>

          <div className="advanced-section" style={sectionStyle}>
            <button className="advanced-section-header" style={sectionHeaderStyle} onClick={() => toggleSection('runs')} type="button">
              <div className="flex items-center gap-2">
                <svg
                  className={`w-4 h-4 transition-transform${expandedSections.has('runs') ? ' rotate-90' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                <span>Run History</span>
              </div>
              <span className="text-xs" style={{ color: 'var(--ac-text-subtle)' }}>
                {runs.length}
              </span>
            </button>

            {expandedSections.has('runs') ? (
              <div className="advanced-section-content">
                {runs.length === 0 ? (
                  <div className="text-sm py-3" style={{ color: 'var(--ac-text-muted)' }}>
                    No run history yet
                  </div>
                ) : (
                  <div className="space-y-2 py-2">
                    {runs.slice(0, 5).map((run) => (
                      <div
                        key={run.id}
                        className="run-item"
                        style={runItemStyle}
                        onClick={() => onToggleRun(run.id)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-2 h-2 rounded-full${run.isInProgress ? ' animate-pulse' : ''}`}
                              style={{ backgroundColor: getRunStatusColor(run) }}
                            />
                            <span className="text-sm" style={{ color: 'var(--ac-text)' }}>
                              {getFlowName(run.flowId)}
                            </span>
                            {run.status ? (
                              <span
                                className="text-xs px-1.5 py-0.5 rounded"
                                style={{
                                  backgroundColor: run.isInProgress
                                    ? 'var(--ac-primary-light, #dbeafe)'
                                    : run.success
                                      ? 'var(--ac-success-light, #dcfce7)'
                                      : 'var(--ac-danger-light, #fee2e2)',
                                  color: getRunStatusColor(run),
                                }}
                              >
                                {getRunStatusText(run)}
                              </span>
                            ) : null}
                          </div>
                          <span className="text-xs" style={{ color: 'var(--ac-text-subtle)' }}>
                            {formatTime(run.startedAt)}
                          </span>
                        </div>

                        {openRunId === run.id ? (
                          <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--ac-border)' }}>
                            {run.entries.length === 0 && run.status ? (
                              <div className="text-xs py-1" style={{ color: 'var(--ac-text-muted)' }}>
                                <div className="flex items-center gap-2">
                                  <span>状态: {getRunStatusText(run)}</span>
                                  {run.finishedAt ? (
                                    <span>
                                      • 耗时:
                                      {Math.round(
                                        (new Date(run.finishedAt).getTime() -
                                          new Date(run.startedAt).getTime()) /
                                          1000,
                                      )}
                                      s
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            ) : null}

                            {run.entries.map((entry, index) => (
                              <div
                                key={`${run.id}-${index}`}
                                className="text-xs py-1"
                                style={{
                                  color:
                                    entry.status === 'failed'
                                      ? 'var(--ac-danger)'
                                      : 'var(--ac-text-muted)',
                                }}
                              >
                                #{index + 1} {entry.status} - step={entry.stepId}
                                {entry.tookMs ? <span className="ml-2">{entry.tookMs}ms</span> : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="advanced-section" style={sectionStyle}>
            <button className="advanced-section-header" style={sectionHeaderStyle} onClick={() => toggleSection('triggers')} type="button">
              <div className="flex items-center gap-2">
                <svg
                  className={`w-4 h-4 transition-transform${expandedSections.has('triggers') ? ' rotate-90' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                <span>Triggers</span>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs" style={{ color: 'var(--ac-text-subtle)' }}>
                  {triggers.length}
                </span>
                <button
                  className="trigger-add-btn"
                  style={triggerAddStyle}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCreateTrigger();
                  }}
                  title="Add trigger"
                  type="button"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                </button>
              </div>
            </button>

            {expandedSections.has('triggers') ? (
              <div className="advanced-section-content">
                {triggers.length === 0 ? (
                  <div className="text-sm py-3" style={{ color: 'var(--ac-text-muted)' }}>
                    No triggers configured
                  </div>
                ) : (
                  <div className="space-y-2 py-2">
                    {triggers.map((trigger) => (
                      <div key={trigger.id} className="trigger-item" style={triggerItemStyle}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span
                              className="w-2 h-2 rounded-full"
                              style={{
                                backgroundColor:
                                  trigger.enabled !== false
                                    ? 'var(--ac-success)'
                                    : 'var(--ac-text-subtle)',
                              }}
                            />
                            <span className="text-sm font-medium" style={{ color: 'var(--ac-text)' }}>
                              {trigger.type}
                            </span>
                            <span className="text-xs" style={{ color: 'var(--ac-text-muted)' }}>
                              {getFlowName(trigger.flowId)}
                            </span>
                          </div>

                          <div className="flex items-center gap-1">
                            <button
                              className="trigger-action"
                              style={triggerActionStyle}
                              onClick={() => onEditTrigger(trigger.id)}
                              title="Edit"
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
                                  d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                                />
                              </svg>
                            </button>
                            <button
                              className="trigger-action trigger-action-danger"
                              style={triggerActionDangerStyle}
                              onClick={() => onRemoveTrigger(trigger.id)}
                              title="Delete"
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
                                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
