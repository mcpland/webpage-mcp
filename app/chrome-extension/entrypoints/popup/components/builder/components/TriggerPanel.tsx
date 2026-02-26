import { useEffect, useMemo, useState } from 'react';

import type { FlowId, TriggerId } from '@/entrypoints/background/record-replay-v3/domain/ids';
import type { JsonObject } from '@/entrypoints/background/record-replay-v3/domain/json';
import type { TriggerSpec } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import { toast } from '@/entrypoints/popup/components/builder/model/toast';
import { useRRV3Rpc } from '@/entrypoints/shared/react/useRRV3Rpc';
import './TriggerPanel.css';

type PanelEditableKind = 'interval' | 'once';
type TriggerOwner = 'panel' | 'triggerNode' | 'external';

type TriggerPanelProps = {
  flowId: string;
  onClose: () => void;
};

function formatLocalDateTime(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return String(ms);
  return date.toLocaleString();
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function unixMsToDatetimeLocal(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function datetimeLocalToUnixMs(value: string): number | null {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const date = new Date(
    Number(yearStr),
    Number(monthStr) - 1,
    Number(dayStr),
    Number(hourStr),
    Number(minuteStr),
    Number(secondStr || 0),
    0,
  );
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

export default function TriggerPanel({ flowId, onClose }: TriggerPanelProps) {
  const rpc = useRRV3Rpc({ autoConnect: true });

  const [loading, setLoading] = useState(false);
  const [triggers, setTriggers] = useState<TriggerSpec[]>([]);
  const [busyIds, setBusyIds] = useState<Record<string, boolean>>({});

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create');
  const [editorKind, setEditorKind] = useState<PanelEditableKind>('interval');
  const [editorEditingId, setEditorEditingId] = useState<TriggerId | null>(null);
  const [editorEnabled, setEditorEnabled] = useState(true);
  const [editorPeriodMinutes, setEditorPeriodMinutes] = useState(5);
  const [editorWhenLocal, setEditorWhenLocal] = useState('');

  const sortedTriggers = useMemo(() => {
    return [...triggers].sort((a, b) => {
      const kindOrder = a.kind.localeCompare(b.kind);
      if (kindOrder !== 0) return kindOrder;
      return a.id.localeCompare(b.id);
    });
  }, [triggers]);

  const editorTitle = `${editorMode === 'create' ? 'Create' : 'Edit'} ${editorKind} Trigger`;

  function setBusy(triggerId: string, value: boolean) {
    setBusyIds((current) => ({ ...current, [triggerId]: value }));
  }

  function isPanelManaged(trigger: TriggerSpec): boolean {
    return trigger.kind === 'interval' || trigger.kind === 'once';
  }

  function ownerOf(trigger: TriggerSpec): TriggerOwner {
    const normalizedFlowId = String(flowId || '');
    const trigPrefix = `trg_${normalizedFlowId}_`;
    const schPrefix = `sch_${normalizedFlowId}_`;

    if (trigger.id.startsWith(trigPrefix) || trigger.id.startsWith(schPrefix)) {
      return 'triggerNode';
    }

    if (isPanelManaged(trigger)) {
      return 'panel';
    }

    return 'external';
  }

  function ownerLabel(owner: TriggerOwner): string {
    switch (owner) {
      case 'triggerNode':
        return 'via trigger node';
      case 'external':
        return 'external';
      default:
        return '';
    }
  }

  function describeTrigger(trigger: TriggerSpec): string {
    switch (trigger.kind) {
      case 'url': {
        const spec = trigger as Extract<TriggerSpec, { kind: 'url' }>;
        const rules = spec.match || [];
        return `URL match rules: ${rules.length}`;
      }
      case 'cron': {
        const spec = trigger as Extract<TriggerSpec, { kind: 'cron' }>;
        return spec.timezone ? `cron: ${spec.cron} (${spec.timezone})` : `cron: ${spec.cron}`;
      }
      case 'interval': {
        const spec = trigger as Extract<TriggerSpec, { kind: 'interval' }>;
        return `Every ${spec.periodMinutes} minute(s)`;
      }
      case 'once': {
        const spec = trigger as Extract<TriggerSpec, { kind: 'once' }>;
        return `At ${formatLocalDateTime(Number(spec.whenMs))}`;
      }
      case 'command': {
        const spec = trigger as Extract<TriggerSpec, { kind: 'command' }>;
        return `commandKey: ${spec.commandKey}`;
      }
      case 'contextMenu': {
        const spec = trigger as Extract<TriggerSpec, { kind: 'contextMenu' }>;
        return `title: ${spec.title}`;
      }
      case 'dom': {
        const spec = trigger as Extract<TriggerSpec, { kind: 'dom' }>;
        return `selector: ${spec.selector}`;
      }
      case 'manual':
        return 'Manual trigger (fire via button)';
      default:
        return '';
    }
  }

  async function refresh(): Promise<void> {
    const normalizedFlowId = String(flowId || '').trim();
    if (!normalizedFlowId) return;

    setLoading(true);
    try {
      await rpc.ensureConnected();
      const result = (await rpc.request('rr_v3.listTriggers', {
        flowId: normalizedFlowId as FlowId,
      })) as TriggerSpec[] | null;
      setTriggers(Array.isArray(result) ? result : []);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setLoading(false);
    }
  }

  async function onToggleEnabled(trigger: TriggerSpec, enabled: boolean): Promise<void> {
    if (busyIds[trigger.id]) return;
    setBusy(trigger.id, true);

    try {
      await rpc.ensureConnected();
      const method = enabled ? 'rr_v3.enableTrigger' : 'rr_v3.disableTrigger';
      await rpc.request(method, { triggerId: trigger.id as TriggerId });
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(trigger.id, false);
    }
  }

  async function fireManual(trigger: TriggerSpec): Promise<void> {
    if (trigger.kind !== 'manual') return;
    if (busyIds[trigger.id]) return;
    setBusy(trigger.id, true);

    try {
      await rpc.ensureConnected();
      const result = (await rpc.request('rr_v3.fireTrigger', {
        triggerId: trigger.id as TriggerId,
      })) as { runId?: string } | null;
      toast(`Triggered: ${result?.runId ?? 'run enqueued'}`, 'info');
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(trigger.id, false);
    }
  }

  function openCreate(kind: PanelEditableKind): void {
    setEditorMode('create');
    setEditorKind(kind);
    setEditorEditingId(null);
    setEditorEnabled(true);
    setEditorPeriodMinutes(5);
    setEditorWhenLocal(unixMsToDatetimeLocal(Date.now() + 5 * 60 * 1000));
    setEditorOpen(true);
  }

  function openEdit(trigger: TriggerSpec): void {
    if (!isPanelManaged(trigger)) return;

    setEditorMode('edit');
    setEditorKind(trigger.kind as PanelEditableKind);
    setEditorEditingId(trigger.id as TriggerId);
    setEditorEnabled(!!trigger.enabled);

    if (trigger.kind === 'interval') {
      const spec = trigger as Extract<TriggerSpec, { kind: 'interval' }>;
      setEditorPeriodMinutes(Number(spec.periodMinutes) || 1);
    } else {
      const spec = trigger as Extract<TriggerSpec, { kind: 'once' }>;
      setEditorWhenLocal(unixMsToDatetimeLocal(Number(spec.whenMs)));
    }

    setEditorOpen(true);
  }

  function closeEditor(): void {
    if (editorSaving) return;
    setEditorOpen(false);
  }

  async function submitEditor(): Promise<void> {
    if (editorSaving) return;

    const normalizedFlowId = String(flowId || '').trim();
    if (!normalizedFlowId) {
      toast('Flow ID is empty', 'error');
      return;
    }

    setEditorSaving(true);
    try {
      await rpc.ensureConnected();

      let payload: Record<string, unknown>;

      if (editorKind === 'interval') {
        const periodMinutes = Math.max(1, Math.floor(Number(editorPeriodMinutes || 1)));
        payload = {
          kind: 'interval',
          enabled: !!editorEnabled,
          flowId: normalizedFlowId as FlowId,
          periodMinutes,
        };
        if (editorEditingId) {
          payload.id = editorEditingId;
        }
      } else {
        const whenMs = datetimeLocalToUnixMs(editorWhenLocal);
        if (whenMs === null) {
          toast('Invalid trigger time format', 'error');
          return;
        }

        if (whenMs < Date.now()) {
          toast('Trigger time is in the past. It may fire immediately.', 'warn');
        }

        payload = {
          kind: 'once',
          enabled: !!editorEnabled,
          flowId: normalizedFlowId as FlowId,
          whenMs,
        };
        if (editorEditingId) {
          payload.id = editorEditingId;
        }
      }

      if (editorMode === 'create') {
        await rpc.request('rr_v3.createTrigger', { trigger: payload as unknown as JsonObject });
      } else {
        await rpc.request('rr_v3.updateTrigger', { trigger: payload as unknown as JsonObject });
      }

      setEditorOpen(false);
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setEditorSaving(false);
    }
  }

  async function removePanelTrigger(trigger: TriggerSpec): Promise<void> {
    if (!isPanelManaged(trigger)) return;

    const confirmed = confirm(`Delete trigger?\n\n${trigger.id}`);
    if (!confirmed) return;
    if (busyIds[trigger.id]) return;

    setBusy(trigger.id, true);
    try {
      await rpc.ensureConnected();
      await rpc.request('rr_v3.deleteTrigger', { triggerId: trigger.id });
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(trigger.id, false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [flowId]);

  return (
    <aside className="builder-trigger-panel">
      <div className="builder-trigger-panel__header">
        <div className="builder-trigger-panel__header-left">
          <div className="builder-trigger-panel__header-title">Triggers</div>
          <div className="builder-trigger-panel__header-sub">{flowId}</div>
        </div>
        <div className="builder-trigger-panel__header-right">
          <button
            className="builder-trigger-panel__btn-sm"
            type="button"
            disabled={loading}
            onClick={() => void refresh()}
          >
            Refresh
          </button>
          <button className="builder-trigger-panel__btn-close" type="button" title="Close" onClick={onClose}>
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
      </div>

      <div className="builder-trigger-panel__content">
        <div className="builder-trigger-panel__section">
          <div className="builder-trigger-panel__section-header">
            <div className="builder-trigger-panel__section-title">Add Trigger</div>
            <div className="builder-trigger-panel__section-actions">
              <button
                className="builder-trigger-panel__btn-sm"
                type="button"
                onClick={() => openCreate('interval')}
              >
                + Interval
              </button>
              <button
                className="builder-trigger-panel__btn-sm"
                type="button"
                onClick={() => openCreate('once')}
              >
                + Once
              </button>
            </div>
          </div>
          <div className="builder-trigger-panel__hint">
            Other types (url/cron/command/contextMenu/dom) are configured via trigger nodes.
          </div>
        </div>

        <div className="builder-trigger-panel__divider" />

        <div className="builder-trigger-panel__section">
          <div className="builder-trigger-panel__section-header">
            <div className="builder-trigger-panel__section-title">
              Current Triggers ({triggers.length})
            </div>
          </div>

          {loading ? <div className="builder-trigger-panel__muted">Loading...</div> : null}
          {!loading && triggers.length === 0 ? (
            <div className="builder-trigger-panel__muted">No triggers configured</div>
          ) : null}

          {!loading && triggers.length > 0 ? (
            <div className="builder-trigger-panel__list">
              {sortedTriggers.map((trigger) => {
                const owner = ownerOf(trigger);
                return (
                  <div key={trigger.id} className="builder-trigger-panel__row">
                    <div className="builder-trigger-panel__main">
                      <div className="builder-trigger-panel__top">
                        <span className="builder-trigger-panel__badge" data-kind={trigger.kind}>
                          {trigger.kind}
                        </span>
                        <span className="builder-trigger-panel__id">{trigger.id}</span>
                        {owner !== 'panel' ? (
                          <span className="builder-trigger-panel__ownership" data-owner={owner}>
                            {ownerLabel(owner)}
                          </span>
                        ) : null}
                      </div>
                      <div className="builder-trigger-panel__desc">{describeTrigger(trigger)}</div>
                    </div>

                    <div className="builder-trigger-panel__actions">
                      <label
                        className={
                          owner === 'triggerNode'
                            ? 'builder-trigger-panel__toggle builder-trigger-panel__toggle--readonly'
                            : 'builder-trigger-panel__toggle'
                        }
                        title={owner === 'triggerNode' ? 'Edit via trigger node in Builder' : ''}
                      >
                        <input
                          type="checkbox"
                          checked={!!trigger.enabled}
                          disabled={!!busyIds[trigger.id] || owner === 'triggerNode'}
                          onChange={(event) => void onToggleEnabled(trigger, event.currentTarget.checked)}
                        />
                        <span>Enabled</span>
                      </label>

                      {trigger.kind === 'manual' ? (
                        <button
                          className="builder-trigger-panel__btn-sm builder-trigger-panel__btn-sm--primary"
                          type="button"
                          disabled={!!busyIds[trigger.id] || !trigger.enabled}
                          onClick={() => void fireManual(trigger)}
                        >
                          Fire
                        </button>
                      ) : null}

                      {isPanelManaged(trigger) ? (
                        <>
                          <button
                            className="builder-trigger-panel__btn-icon-sm"
                            type="button"
                            title="Edit"
                            disabled={!!busyIds[trigger.id]}
                            onClick={() => openEdit(trigger)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
                            </svg>
                          </button>
                          <button
                            className="builder-trigger-panel__btn-icon-sm builder-trigger-panel__btn-icon-sm--danger"
                            type="button"
                            title="Delete"
                            disabled={!!busyIds[trigger.id]}
                            onClick={() => void removePanelTrigger(trigger)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                            </svg>
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      {editorOpen ? (
        <div className="builder-trigger-modal" onClick={closeEditor}>
          <div className="builder-trigger-modal__dialog builder-trigger-modal__dialog--small" onClick={(event) => event.stopPropagation()}>
            <div className="builder-trigger-modal__header">
              <div className="builder-trigger-modal__title">{editorTitle}</div>
              <button className="builder-trigger-modal__close" type="button" onClick={closeEditor}>
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

            <div className="builder-trigger-modal__body">
              <div className="builder-trigger-modal__form-group">
                <label className="builder-trigger-modal__form-label">Type</label>
                <select
                  className="builder-trigger-modal__form-input"
                  value={editorKind}
                  disabled={editorMode === 'edit'}
                  onChange={(event) => setEditorKind(event.currentTarget.value as PanelEditableKind)}
                >
                  <option value="interval">interval</option>
                  <option value="once">once</option>
                </select>
              </div>

              <div className="builder-trigger-modal__form-group builder-trigger-modal__form-group--checkbox">
                <label className="builder-trigger-modal__checkbox-label">
                  <input
                    type="checkbox"
                    checked={editorEnabled}
                    onChange={(event) => setEditorEnabled(event.currentTarget.checked)}
                  />
                  <span>Enabled</span>
                </label>
              </div>

              {editorKind === 'interval' ? (
                <>
                  <div className="builder-trigger-modal__form-group">
                    <label className="builder-trigger-modal__form-label">Interval (minutes)</label>
                    <input
                      className="builder-trigger-modal__form-input"
                      type="number"
                      min="1"
                      step="1"
                      value={editorPeriodMinutes}
                      onChange={(event) => setEditorPeriodMinutes(Number(event.currentTarget.value || 1))}
                    />
                  </div>
                  <div className="builder-trigger-panel__hint">
                    Uses chrome.alarms.periodInMinutes for repeating triggers.
                  </div>
                </>
              ) : (
                <>
                  <div className="builder-trigger-modal__form-group">
                    <label className="builder-trigger-modal__form-label">Trigger Time</label>
                    <input
                      className="builder-trigger-modal__form-input"
                      type="datetime-local"
                      value={editorWhenLocal}
                      onChange={(event) => setEditorWhenLocal(event.currentTarget.value)}
                    />
                  </div>
                  <div className="builder-trigger-panel__hint">
                    Will auto-disable after firing. Time is in local timezone.
                  </div>
                </>
              )}
            </div>

            <div className="builder-trigger-modal__footer">
              <button className="builder-trigger-modal__btn-cancel" type="button" onClick={closeEditor}>
                Cancel
              </button>
              <button
                className="builder-trigger-modal__btn-primary"
                type="button"
                disabled={editorSaving}
                onClick={() => void submitEditor()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
