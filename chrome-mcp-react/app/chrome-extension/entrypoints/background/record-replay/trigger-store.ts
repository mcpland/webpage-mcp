import { IndexedDbStorage, ensureMigratedFromLocal } from './storage/indexeddb-manager';

export type TriggerType = 'url' | 'contextMenu' | 'command' | 'dom';

export interface BaseTrigger {
  id: string;
  type: TriggerType;
  enabled: boolean;
  flowId: string;
  args?: Record<string, any>;
}

export interface UrlTrigger extends BaseTrigger {
  type: 'url';
  match: Array<{ kind: 'url' | 'domain' | 'path'; value: string }>;
}

export interface ContextMenuTrigger extends BaseTrigger {
  type: 'contextMenu';
  title: string;
  contexts?: chrome.contextMenus.ContextType[];
}

export interface CommandTrigger extends BaseTrigger {
  type: 'command';
  commandKey: string; // e.g., run_quick_trigger_1
}

export interface DomTrigger extends BaseTrigger {
  type: 'dom';
  selector: string;
  appear?: boolean; // default true
  once?: boolean; // default true
  debounceMs?: number; // default 800
}

export type FlowTrigger = UrlTrigger | ContextMenuTrigger | CommandTrigger | DomTrigger;

export async function listTriggers(): Promise<FlowTrigger[]> {
  await ensureMigratedFromLocal();
  return await IndexedDbStorage.triggers.list();
}

export async function saveTrigger(t: FlowTrigger): Promise<void> {
  await ensureMigratedFromLocal();
  await IndexedDbStorage.triggers.save(t);
}

export async function deleteTrigger(id: string): Promise<void> {
  await ensureMigratedFromLocal();
  await IndexedDbStorage.triggers.delete(id);
}

export function toId(prefix = 'trg') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
