// engine/state-manager.ts — lightweight run state store with events and persistence

type Listener<T> = (payload: T) => void;

export interface RunState {
  id: string;
  flowId: string;
  name?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  updatedAt: number;
}

export class StateManager<T extends { id: string }> {
  private key: string;
  private states = new Map<string, T>();
  private listeners: Record<string, Listener<any>[]> = Object.create(null);

  constructor(storageKey: string) {
    this.key = storageKey;
  }

  on<E = any>(name: string, listener: Listener<E>) {
    (this.listeners[name] = this.listeners[name] || []).push(listener);
  }

  off<E = any>(name: string, listener: Listener<E>) {
    const arr = this.listeners[name];
    if (!arr) return;
    const i = arr.indexOf(listener as any);
    if (i >= 0) arr.splice(i, 1);
  }

  private emit<E = any>(name: string, payload: E) {
    const arr = this.listeners[name] || [];
    for (const fn of arr)
      try {
        fn(payload);
      } catch {}
  }

  getAll(): Map<string, T> {
    return this.states;
  }

  get(id: string): T | undefined {
    return this.states.get(id);
  }

  async add(id: string, data: T): Promise<void> {
    this.states.set(id, data);
    this.emit('add', { id, data });
    await this.persist();
  }

  async update(id: string, patch: Partial<T>): Promise<void> {
    const cur = this.states.get(id);
    if (!cur) return;
    const next = Object.assign({}, cur, patch);
    this.states.set(id, next);
    this.emit('update', { id, data: next });
    await this.persist();
  }

  async delete(id: string): Promise<void> {
    this.states.delete(id);
    this.emit('delete', { id });
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      const obj = Object.fromEntries(this.states.entries());
      await chrome.storage.local.set({ [this.key]: obj });
    } catch {}
  }

  async restore(): Promise<void> {
    try {
      const res = await chrome.storage.local.get(this.key);
      const obj = (res && res[this.key]) || {};
      this.states = new Map(Object.entries(obj) as any);
    } catch {}
  }
}

export const runState = new StateManager<RunState>('rr_run_states');
