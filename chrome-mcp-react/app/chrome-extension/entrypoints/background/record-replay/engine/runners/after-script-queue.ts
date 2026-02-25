// after-script-queue.ts — queue + executor for deferred after-scripts
// Notes:
// - Executes user-provided code in the specified world (ISOLATED by default)
// - Clears queue before execution to avoid leaks; re-queues remainder on failure
// - Logs warnings instead of throwing to keep the main engine resilient

import type { StepScript } from '../../types';
import type { ExecCtx } from '../../nodes';
import { RunLogger } from '../logging/run-logger';
import { applyAssign } from '../../rr-utils';

export class AfterScriptQueue {
  private queue: StepScript[] = [];

  constructor(private logger: RunLogger) {}

  enqueue(script: StepScript) {
    this.queue.push(script);
  }

  size() {
    return this.queue.length;
  }

  async flush(ctx: ExecCtx, vars: Record<string, any>) {
    if (this.queue.length === 0) return;
    const scriptsToFlush = this.queue.splice(0, this.queue.length);
    for (let i = 0; i < scriptsToFlush.length; i++) {
      const s = scriptsToFlush[i]!;
      const tScript = Date.now();
      const world = (s as any).world || 'ISOLATED';
      const code = String((s as any).code || '');
      if (!code.trim()) {
        this.logger.push({ stepId: s.id, status: 'success', tookMs: Date.now() - tScript });
        continue;
      }
      try {
        // Warn on obviously dangerous constructs; not a sandbox, just visibility.
        const dangerous =
          /[;{}]|\b(function|=>|while|for|class|globalThis|window|self|this|constructor|__proto__|prototype|eval|Function|import|require|XMLHttpRequest|fetch|chrome)\b/;
        if (dangerous.test(code)) {
          this.logger.push({
            stepId: s.id,
            status: 'warning',
            message: 'Script contains potentially unsafe tokens; executed in isolated world',
          });
        }
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs?.[0]?.id;
        if (typeof tabId !== 'number') throw new Error('Active tab not found');
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (userCode: string) => {
            try {
              return (0, eval)(userCode);
            } catch (e) {
              return { __error: true, message: String(e) } as any;
            }
          },
          args: [code],
          world: world as any,
        } as any);
        if ((result as any)?.__error) {
          this.logger.push({
            stepId: s.id,
            status: 'warning',
            message: `After-script error: ${(result as any).message || 'unknown'}`,
          });
        }
        const value = (result as any)?.__error ? null : result;
        if ((s as any).saveAs) (vars as any)[(s as any).saveAs] = value;
        if ((s as any).assign && typeof (s as any).assign === 'object')
          applyAssign(vars, value, (s as any).assign);
      } catch (e: any) {
        // Re-queue remaining and stop flush cycle for now
        const remaining = scriptsToFlush.slice(i + 1);
        if (remaining.length) this.queue.unshift(...remaining);
        this.logger.push({
          stepId: s.id,
          status: 'warning',
          message: `After-script execution failed: ${e?.message || String(e)}`,
        });
        break;
      }
      this.logger.push({ stepId: s.id, status: 'success', tookMs: Date.now() - tScript });
    }
  }
}
