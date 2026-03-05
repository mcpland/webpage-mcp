import { type CSSProperties, useMemo, useState } from 'react';

import { getMessage } from '@/utils/i18n';
import WorkflowListItem, { type WorkflowFlowLite } from './WorkflowListItem';
import './WorkflowsView.css';

export type FlowLite = WorkflowFlowLite;

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

export interface RecordingStateLite {
  status: 'idle' | 'recording' | 'paused' | 'stopping';
  stepCount: number;
  startedAt?: string | null;
  flowName?: string | null;
}

export interface TimelineStepLite {
  id?: string;
  type?: string;
  target?: { selector?: string };
  value?: unknown;
  url?: string;
  keys?: string;
}

export type WorkflowsViewProps = {
  flows: FlowLite[];
  runs: RunLite[];
  recordingState: RecordingStateLite;
  timelineSteps: TimelineStepLite[];
  recordingAction: 'start' | 'stop' | null;
  onlyBound: boolean;
  openRunId: string | null;
  onRefresh: () => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCreate: () => void;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onOnlyBoundChange: (value: boolean) => void;
  onToggleRun: (id: string) => void;
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

const recordingStartButtonStyle: CSSProperties = {
  backgroundColor: '#dc2626',
  color: '#ffffff',
  borderRadius: 'var(--ac-radius-button)',
};

const recordingStopButtonStyle: CSSProperties = {
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text)',
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

export default function WorkflowsView({
  flows,
  runs,
  recordingState,
  timelineSteps,
  recordingAction,
  onlyBound,
  openRunId,
  onRefresh,
  onStartRecording,
  onStopRecording,
  onCreate,
  onRun,
  onEdit,
  onDelete,
  onExport,
  onOnlyBoundChange,
  onToggleRun,
}: WorkflowsViewProps) {
  const t = (key: string, fallback: string, substitutions?: string[]): string =>
    getMessage(key, substitutions, fallback);
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
  const isRecordingActive = recordingState.status !== 'idle';
  const canStartRecording = !isRecordingActive && recordingAction === null;
  const canStopRecording = isRecordingActive && recordingAction === null;

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
        queued: t('workflowsRunQueued', 'Queued'),
        running: t('workflowsRunRunning', 'Running'),
        paused: t('workflowsRunPaused', 'Paused'),
        succeeded: t('workflowsRunSucceeded', 'Succeeded'),
        failed: t('workflowsRunFailed', 'Failed'),
        canceled: t('workflowsRunCanceled', 'Canceled'),
      };
      return statusMap[run.status] || run.status;
    }
    return run.success
      ? t('workflowsRunSucceeded', 'Succeeded')
      : t('workflowsRunFailed', 'Failed');
  }

  function formatTime(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleString();
  }

  function formatTimelineStep(step: TimelineStepLite): string {
    const type = String(step.type || '').trim();
    const selector = step.target?.selector ? String(step.target.selector) : '';
    if (type === 'click' || type === 'dblclick') {
      return `${type}: ${selector || '(document)'}`;
    }
    if (type === 'fill') {
      return `fill ${selector || ''}`;
    }
    if (type === 'navigate') {
      return `navigate ${step.url || ''}`;
    }
    if (type === 'key') {
      return `key ${String(step.keys || '')}`;
    }
    if (type === 'scroll') {
      return 'scroll';
    }
    return type || 'step';
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
              placeholder={t('workflowsSearchPlaceholder', 'Search workflows...')}
              className="w-full pl-9 pr-3 py-2 text-sm"
              style={inputStyle}
            />
          </div>

          <button
            className="flex-shrink-0 p-2"
            style={refreshButtonStyle}
            onClick={onRefresh}
            title={t('workflowsRefreshTitle', 'Refresh')}
            type="button"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>

          <button
            className={`flex-shrink-0 px-3 py-2 text-sm font-medium${isRecordingActive ? ' workflow-recording-active' : ''}`}
            style={recordingStartButtonStyle}
            onClick={onStartRecording}
            type="button"
            disabled={!canStartRecording}
            title={t('workflowsStartRecordingTitle', 'Start recording')}
          >
            <span className="flex items-center gap-1">
              <span className={`workflow-record-dot${isRecordingActive ? ' animate-pulse' : ''}`} />
              {recordingAction === 'start'
                ? t('workflowsRecordingStarting', 'Starting...')
                : t('workflowsNewRecordingButton', 'New Recording')}
            </span>
          </button>

          <button
            className="flex-shrink-0 px-3 py-2 text-sm font-medium workflow-record-stop"
            style={recordingStopButtonStyle}
            onClick={onStopRecording}
            type="button"
            disabled={!canStopRecording}
            title={t('workflowsStopRecordingTitle', 'Stop recording')}
          >
            {recordingAction === 'stop'
              ? t('workflowsRecordingStopping', 'Stopping...')
              : t('workflowsStopRecordingButton', 'Stop')}
          </button>

          <button className="flex-shrink-0 px-3 py-2 text-sm font-medium" style={newButtonStyle} onClick={onCreate} type="button">
            <span className="flex items-center gap-1">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
              </svg>
              {t('workflowsCreateButton', 'New')}
            </span>
          </button>
        </div>

        {isRecordingActive || timelineSteps.length > 0 ? (
          <div className="recording-panel">
            <div className="recording-panel-header">
              <span className="recording-status-chip">
                {recordingState.status === 'recording'
                  ? t('workflowsRecordingStatusRecording', 'Recording')
                  : recordingState.status === 'paused'
                    ? t('workflowsRecordingStatusPaused', 'Paused')
                    : recordingState.status === 'stopping'
                      ? t('workflowsRecordingStatusStopping', 'Stopping')
                      : t('workflowsRecordingStatusIdle', 'Idle')}
              </span>
              <span className="recording-meta">
                {t('workflowsRecordingStepCount', '{0} steps', [String(recordingState.stepCount || timelineSteps.length)])}
              </span>
            </div>
            {timelineSteps.length > 0 ? (
              <ol className="recording-timeline-list">
                {timelineSteps.slice(-8).map((step, index) => (
                  <li key={step.id || `${step.type || 'step'}-${index}`} className="recording-timeline-item">
                    <span className="recording-timeline-index">{timelineSteps.length - Math.min(8, timelineSteps.length) + index + 1}.</span>
                    <span className="recording-timeline-text">{formatTimelineStep(step)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="recording-timeline-empty">
                {t('workflowsRecordingWaiting', 'Waiting for interaction...')}
              </div>
            )}
          </div>
        ) : null}

        <div className="flex items-center justify-between mt-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--ac-text-muted)' }}>
            <input
              type="checkbox"
              checked={onlyBound}
              onChange={(event) => onOnlyBoundChange(event.currentTarget.checked)}
              className="workflow-checkbox"
            />
            <span>{t('workflowsCurrentPageOnly', 'Current page only')}</span>
          </label>

          <span className="text-xs" style={{ color: 'var(--ac-text-subtle)' }}>
            {filteredFlows.length}{' '}
            {filteredFlows.length !== 1
              ? t('workflowsCountPlural', 'workflows')
              : t('workflowsCountSingular', 'workflow')}
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
              {searchQuery
                ? t('workflowsEmptySearchTitle', 'No matching workflows')
                : t('workflowsEmptyTitle', 'No workflows yet')}
            </div>
            <div className="text-xs text-center mb-4" style={{ color: 'var(--ac-text-muted)' }}>
              {searchQuery
                ? t('workflowsEmptySearchDesc', 'Try a different search term')
                : t('workflowsEmptyDesc', 'Record your first automation workflow')}
            </div>
            {!searchQuery ? (
              <button className="px-4 py-2 text-sm font-medium" style={newButtonStyle} onClick={onCreate} type="button">
                {t('workflowsCreateWorkflow', 'Create workflow')}
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
              {t('workflowsAdvancedSection', 'Advanced')}
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
                <span>{t('workflowsRunHistory', 'Run history')}</span>
              </div>
              <span className="text-xs" style={{ color: 'var(--ac-text-subtle)' }}>
                {runs.length}
              </span>
            </button>

            {expandedSections.has('runs') ? (
              <div className="advanced-section-content">
                {runs.length === 0 ? (
                  <div className="text-sm py-3" style={{ color: 'var(--ac-text-muted)' }}>
                    {t('workflowsNoRunHistory', 'No run history yet')}
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
                                  <span>
                                    {t('workflowsRunStatusPrefix', 'Status')}: {getRunStatusText(run)}
                                  </span>
                                  {run.finishedAt ? (
                                    <span>
                                      • {t('workflowsRunDurationPrefix', 'Time taken')}:
                                      {Math.round(
                                        (new Date(run.finishedAt).getTime() -
                                          new Date(run.startedAt).getTime()) /
                                          1000,
                                      )}
                                      {t('workflowsSecondsUnit', 's')}
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
                                {t('workflowsRunEntrySummary', '#{0} {1} - step={2}', [
                                  String(index + 1),
                                  String(entry.status || ''),
                                  String(entry.stepId || ''),
                                ])}
                                {entry.tookMs ? (
                                  <span className="ml-2">
                                    {t('workflowsMillisecondsValue', '{0}ms', [String(entry.tookMs)])}
                                  </span>
                                ) : null}
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

        </div>
      </div>
    </div>
  );
}
