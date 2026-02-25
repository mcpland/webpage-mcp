import { BACKGROUND_MESSAGE_TYPES, CONTENT_MESSAGE_TYPES } from '@/common/message-types';
import { Flow } from './types';
import {
  listFlows,
  saveFlow,
  getFlow,
  deleteFlow,
  publishFlow,
  unpublishFlow,
  exportFlow,
  exportAllFlows,
  importFlowFromJson,
  listSchedules,
  saveSchedule,
  removeSchedule,
  type FlowSchedule,
} from './flow-store';
import { listRuns } from './flow-store';
import { STORAGE_KEYS } from '@/common/constants';
import { listTriggers, saveTrigger, deleteTrigger, type FlowTrigger } from './trigger-store';
import { runFlow } from './flow-runner';
import { RecorderManager } from './recording/recorder-manager';
import { recordingSession } from './recording/session-manager';
// Browser/content listeners are initialized via RecorderManager.init

// design note: background listener for record & replay; delegates recording to dedicated modules

// Alarm helpers for schedules
async function rescheduleAlarms() {
  const schedules = await listSchedules();
  // Clear existing rr_schedule_* alarms
  const alarms = await chrome.alarms.getAll();
  await Promise.all(
    alarms
      .filter((a) => a.name && a.name.startsWith('rr_schedule_'))
      .map((a) => chrome.alarms.clear(a.name)),
  );
  for (const s of schedules) {
    if (!s.enabled) continue;
    const name = `rr_schedule_${s.id}`;
    if (s.type === 'interval') {
      const minutes = Math.max(1, Math.floor(Number(s.when) || 0));
      await chrome.alarms.create(name, { periodInMinutes: minutes });
    } else if (s.type === 'once') {
      const whenMs = Date.parse(s.when);
      if (Number.isFinite(whenMs)) await chrome.alarms.create(name, { when: whenMs });
    } else if (s.type === 'daily') {
      // daily HH:mm local time
      const [hh, mm] = String(s.when || '00:00')
        .split(':')
        .map((x) => Number(x));
      const now = new Date();
      const next = new Date();
      next.setHours(hh || 0, mm || 0, 0, 0);
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
      await chrome.alarms.create(name, { when: next.getTime(), periodInMinutes: 24 * 60 });
    }
  }
}

// legacy injection helpers removed — use recording/content-injection when needed

async function startRecording(meta?: Partial<Flow>): Promise<{ success: boolean; error?: string }> {
  return await RecorderManager.start(meta);
}

async function stopRecording(): Promise<{ success: boolean; flow?: Flow; error?: string }> {
  return await RecorderManager.stop();
}

export function initRecordReplayListeners() {
  // Storage state sync is handled within session manager and recorder manager
  // On startup, re-schedule alarms
  rescheduleAlarms().catch(() => {});
  // Initialize trigger engine (contextMenus/commands/url/dom)
  initTriggerEngine().catch(() => {});
  // Initialize recorder manager (wires browser and content listeners)
  RecorderManager.init().catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      // rr_recorder_event 交由 ContentMessageHandler 处理
      switch (message?.type) {
        case BACKGROUND_MESSAGE_TYPES.RR_START_RECORDING: {
          startRecording(message.meta)
            .then(sendResponse)
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_STOP_RECORDING: {
          stopRecording()
            .then(sendResponse)
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_PAUSE_RECORDING: {
          RecorderManager.pause()
            .then(sendResponse)
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_RESUME_RECORDING: {
          RecorderManager.resume()
            .then(sendResponse)
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_GET_RECORDING_STATUS: {
          const status = recordingSession.getStatus();
          const session = recordingSession.getSession();
          sendResponse({
            success: true,
            status,
            sessionId: session.sessionId,
            originTabId: session.originTabId,
          });
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_FLOWS: {
          listFlows()
            .then((flows) => sendResponse({ success: true, flows }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_GET_FLOW: {
          getFlow(message.flowId)
            .then((flow) => sendResponse({ success: !!flow, flow }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_DELETE_FLOW: {
          deleteFlow(message.flowId)
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_PUBLISH_FLOW: {
          getFlow(message.flowId)
            .then(async (flow) => {
              if (!flow) return sendResponse({ success: false, error: 'flow not found' });
              await publishFlow(flow, message.slug);
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_UNPUBLISH_FLOW: {
          unpublishFlow(message.flowId)
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_RUN_FLOW: {
          getFlow(message.flowId)
            .then(async (flow) => {
              if (!flow) return sendResponse({ success: false, error: 'flow not found' });
              const result = await runFlow(flow, message.options || {});
              sendResponse({ success: true, result });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_SAVE_FLOW: {
          const flow = message.flow as Flow;
          if (!flow || !flow.id) {
            sendResponse({ success: false, error: 'invalid flow' });
            return true;
          }
          saveFlow(flow)
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_EXPORT_FLOW: {
          exportFlow(message.flowId)
            .then((json) => sendResponse({ success: true, json }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_EXPORT_ALL: {
          exportAllFlows()
            .then((json) => sendResponse({ success: true, json }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_IMPORT_FLOW: {
          importFlowFromJson(message.json)
            .then((flows) => sendResponse({ success: true, imported: flows.length, flows }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_RUNS: {
          listRuns()
            .then((runs) => sendResponse({ success: true, runs }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_TRIGGERS: {
          listTriggers()
            .then((triggers) => sendResponse({ success: true, triggers }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_SAVE_TRIGGER: {
          const t = message.trigger as FlowTrigger;
          if (!t || !t.id || !t.type || !t.flowId) {
            sendResponse({ success: false, error: 'invalid trigger' });
            return true;
          }
          saveTrigger(t)
            .then(async () => {
              await refreshTriggers();
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_DELETE_TRIGGER: {
          const id = String(message.id || '');
          if (!id) {
            sendResponse({ success: false, error: 'invalid id' });
            return true;
          }
          deleteTrigger(id)
            .then(async () => {
              await refreshTriggers();
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_REFRESH_TRIGGERS: {
          refreshTriggers()
            .then(() => sendResponse({ success: true }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_LIST_SCHEDULES: {
          listSchedules()
            .then((s) => sendResponse({ success: true, schedules: s }))
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_SCHEDULE_FLOW: {
          const s = message.schedule as FlowSchedule;
          if (!s || !s.id || !s.flowId) {
            sendResponse({ success: false, error: 'invalid schedule' });
            return true;
          }
          saveSchedule(s)
            .then(async () => {
              await rescheduleAlarms();
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
        case BACKGROUND_MESSAGE_TYPES.RR_UNSCHEDULE_FLOW: {
          const scheduleId = String(message.scheduleId || '');
          if (!scheduleId) {
            sendResponse({ success: false, error: 'invalid scheduleId' });
            return true;
          }
          removeSchedule(scheduleId)
            .then(async () => {
              await rescheduleAlarms();
              sendResponse({ success: true });
            })
            .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
          return true;
        }
      }
    } catch (err) {
      sendResponse({ success: false, error: (err as any)?.message || String(err) });
    }
    return false;
  });

  // Trigger engine: contextMenus/commands/url/dom
  if ((chrome as any).contextMenus?.onClicked?.addListener) {
    chrome.contextMenus.onClicked.addListener(async (info) => {
      try {
        const triggers = await listTriggers();
        const t = triggers.find(
          (x) => x.type === 'contextMenu' && (x as any).menuId === info.menuItemId,
        );
        if (!t || t.enabled === false) return;
        const flow = await getFlow(t.flowId);
        if (!flow) return;
        await runFlow(flow, { args: t.args || {}, returnLogs: false });
      } catch {}
    });
  }
  chrome.commands.onCommand.addListener(async (command) => {
    try {
      const triggers = await listTriggers();
      const t = triggers.find((x) => x.type === 'command' && (x as any).commandKey === command);
      if (!t || t.enabled === false) return;
      const flow = await getFlow(t.flowId);
      if (!flow) return;
      await runFlow(flow, { args: t.args || {}, returnLogs: false });
    } catch {}
  });
  chrome.webNavigation.onCommitted.addListener(async (details) => {
    try {
      if (details.frameId !== 0) return;
      const url = details.url || '';
      // Ensure core content scripts are injected for this tab (pre-heat for replay)
      await ensureCoreInjected(details.tabId);
      // Ensure DOM observer is active on this tab (if triggers exist)
      try {
        const { [STORAGE_KEYS.RR_TRIGGERS]: stored } =
          (await chrome.storage.local.get(STORAGE_KEYS.RR_TRIGGERS)) || {};
        const triggers: any[] = Array.isArray(stored) ? stored : [];
        const domTriggers = triggers
          .filter((x) => x.type === 'dom' && x.enabled !== false)
          .map((x: any) => ({
            id: x.id,
            selector: x.selector,
            appear: x.appear !== false,
            once: x.once !== false,
            debounceMs: x.debounceMs ?? 800,
          }));
        if (typeof details.tabId === 'number') {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: details.tabId, allFrames: true },
              files: ['inject-scripts/dom-observer.js'],
              world: 'ISOLATED',
            } as any);
            await chrome.tabs.sendMessage(details.tabId, {
              action: 'set_dom_triggers',
              triggers: domTriggers,
            } as any);
          } catch {}
        }
      } catch {}
      const triggers = await listTriggers();
      const list = triggers.filter((x) => x.type === 'url' && x.enabled !== false) as any[];
      for (const t of list) {
        if (matchUrl(url, (t as any).match || [])) {
          const flow = await getFlow(t.flowId);
          if (!flow) continue;
          await runFlow(flow, { args: t.args || {}, returnLogs: false });
        }
      }
    } catch {}
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message && message.action === 'dom_trigger_fired') {
        const id = message.triggerId;
        listTriggers().then(async (arr) => {
          const t = arr.find((x) => x.id === id && x.type === 'dom');
          if (!t || t.enabled === false) return;
          const flow = await getFlow(t.flowId);
          if (!flow) return;
          await runFlow(flow, { args: t.args || {}, returnLogs: false });
        });
        sendResponse({ ok: true });
        return true;
      }
    } catch {}
    return false;
  });
}

function matchUrl(
  u: string,
  rules: Array<{ kind: 'url' | 'domain' | 'path'; value: string }>,
): boolean {
  try {
    const url = new URL(u);
    for (const r of rules || []) {
      const v = String(r.value || '');
      if (r.kind === 'url' && u.startsWith(v)) return true;
      if (r.kind === 'domain' && url.hostname.includes(v)) return true;
      if (r.kind === 'path' && url.pathname.startsWith(v)) return true;
    }
  } catch {}
  return false;
}

// Track context menu IDs created by record-replay to avoid removing other menus
const rrContextMenuIds = new Set<string>();

async function refreshContextMenus(triggers: FlowTrigger[]) {
  if (!(chrome as any).contextMenus?.create) return;

  // Remove only our own menu items
  await removeRecordReplayMenus();

  // Create menus for enabled context menu triggers
  for (const t of triggers) {
    if (t.type !== 'contextMenu' || t.enabled === false) continue;
    const id = `rr_menu_${t.id}`;
    (t as any).menuId = id;

    try {
      await chrome.contextMenus.create({
        id,
        title: (t as any).title || '运行工作流',
        contexts: (t as any).contexts || ['all'],
      });
      rrContextMenuIds.add(id);
    } catch (err) {
      console.warn('[RecordReplay] Failed to create context menu:', err);
    }
  }
}

async function removeRecordReplayMenus() {
  if (!(chrome as any).contextMenus?.remove) {
    rrContextMenuIds.clear();
    return;
  }

  const pending = Array.from(rrContextMenuIds.values()).map((id) =>
    chrome.contextMenus.remove(id).catch(() => {}),
  );

  if (pending.length) await Promise.all(pending);
  rrContextMenuIds.clear();
}

async function refreshTriggers() {
  try {
    const triggers = await listTriggers();
    await refreshContextMenus(triggers);
    await chrome.storage.local.set({ [STORAGE_KEYS.RR_TRIGGERS]: triggers });
    const domTriggers = triggers
      .filter((x) => x.type === 'dom' && x.enabled !== false)
      .map((x: any) => ({
        id: x.id,
        selector: x.selector,
        appear: x.appear !== false,
        once: x.once !== false,
        debounceMs: x.debounceMs ?? 800,
      }));
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: t.id, allFrames: true },
          files: ['inject-scripts/dom-observer.js'],
          world: 'ISOLATED',
        } as any);
        await chrome.tabs.sendMessage(t.id, {
          action: 'set_dom_triggers',
          triggers: domTriggers,
        } as any);
      } catch {}
    }
  } catch {}
}

// Backward-compatible init function; initialize all trigger-related hooks/state
async function initTriggerEngine() {
  await refreshTriggers();
}

// Ensure core content scripts are present for a tab after navigation
async function ensureCoreInjected(tabId?: number) {
  try {
    if (typeof tabId !== 'number') return;
    // Ping accessibility helper
    const ok = await pingTab(tabId, CONTENT_MESSAGE_TYPES.ACCESSIBILITY_TREE_HELPER_PING);
    if (!ok) {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['inject-scripts/inject-bridge.js', 'inject-scripts/accessibility-tree-helper.js'],
        world: 'ISOLATED',
      } as any);
    }
  } catch {}
}

async function pingTab(tabId: number, action: string): Promise<boolean> {
  try {
    const resp: any = await chrome.tabs.sendMessage(tabId, { action } as any);
    if (!resp) return false;
    // Helpers generally respond { status: 'pong' } or { ok: true }
    return resp.status === 'pong' || resp.ok === true;
  } catch {
    return false;
  }
}

// Alarm listener executes scheduled flows
chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (!alarm?.name || !alarm.name.startsWith('rr_schedule_')) return;
    const id = alarm.name.slice('rr_schedule_'.length);
    const schedules = await listSchedules();
    const s = schedules.find((x) => x.id === id && x.enabled);
    if (!s) return;
    const flow = await getFlow(s.flowId);
    if (!flow) return;
    await runFlow(flow, { args: s.args || {}, returnLogs: false });
  } catch (e) {
    // swallow to not spam logs
  }
});
