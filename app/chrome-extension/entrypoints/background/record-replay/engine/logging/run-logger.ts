// engine/logging/run-logger.ts — run logs, overlay and persistence
import type { RunLogEntry, RunRecord, Flow } from '../../types';
import { appendRun } from '../../flow-store';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { handleCallTool } from '@/entrypoints/background/tools';

export class RunLogger {
  private logs: RunLogEntry[] = [];
  private targetTabId: number | null = null;
  constructor(private runId: string) {}

  push(e: RunLogEntry) {
    this.logs.push(e);
  }

  getLogs() {
    return this.logs;
  }

  setTargetTabId(tabId: number | null | undefined) {
    this.targetTabId = typeof tabId === 'number' ? tabId : null;
  }

  private async resolveOverlayTabId(): Promise<number | undefined> {
    if (typeof this.targetTabId === 'number') {
      try {
        const tab = await chrome.tabs.get(this.targetTabId);
        if (typeof tab?.id === 'number') {
          return tab.id;
        }
      } catch {
        this.targetTabId = null;
      }
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id;
  }

  async overlayInit() {
    try {
      const tabId = await this.resolveOverlayTabId();
      if (typeof tabId === 'number')
        await chrome.tabs.sendMessage(tabId, { action: 'rr_overlay', cmd: 'init' } as any);
    } catch {}
  }

  async overlayAppend(text: string) {
    try {
      const tabId = await this.resolveOverlayTabId();
      if (typeof tabId === 'number')
        await chrome.tabs.sendMessage(tabId, {
          action: 'rr_overlay',
          cmd: 'append',
          text,
        } as any);
    } catch {}
  }

  async overlayDone() {
    try {
      const tabId = await this.resolveOverlayTabId();
      if (typeof tabId === 'number')
        await chrome.tabs.sendMessage(tabId, { action: 'rr_overlay', cmd: 'done' } as any);
    } catch {}
  }

  async captureScreenshotBase64(tabId?: number): Promise<string | null> {
    try {
      let resolvedTabId: number | undefined;
      if (typeof tabId === 'number') {
        resolvedTabId = tabId;
      } else {
        resolvedTabId = await this.resolveOverlayTabId();
      }
      const shot = await handleCallTool({
        name: TOOL_NAMES.BROWSER.COMPUTER,
        args:
          typeof resolvedTabId === 'number'
            ? { action: 'screenshot', tabId: resolvedTabId }
            : { action: 'screenshot' },
      });
      const img = (shot?.content?.find((c: any) => c.type === 'image') as any)?.data as
        | string
        | undefined;
      return img || null;
    } catch {
      return null;
    }
  }

  async screenshotOnFailure(tabId?: number) {
    const img = await this.captureScreenshotBase64(tabId);
    if (img && this.logs.length > 0) this.logs[this.logs.length - 1].screenshotBase64 = img;
  }

  async persist(flow: Flow, startedAt: number, success: boolean) {
    const record: RunRecord = {
      id: this.runId,
      flowId: flow.id,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      success,
      entries: this.logs,
    };
    await appendRun(record);
  }
}
