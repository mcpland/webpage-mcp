import type {
  RunPlugin,
  HookControl,
  RunContext,
  StepContext,
  StepAfterContext,
  StepErrorContext,
  StepRetryContext,
  RunEndContext,
  SubflowContext,
} from './types';

export class PluginManager {
  constructor(private plugins: RunPlugin[]) {}

  async runStart(ctx: RunContext) {
    for (const p of this.plugins) await safeCall(p, 'onRunStart', ctx);
  }

  async beforeStep(ctx: StepContext): Promise<HookControl | undefined> {
    for (const p of this.plugins) {
      const out = await safeCall(p, 'onBeforeStep', ctx);
      if (out && (out.pause || out.nextLabel)) return out;
    }
    return undefined;
  }

  async afterStep(ctx: StepAfterContext) {
    for (const p of this.plugins) await safeCall(p, 'onAfterStep', ctx);
  }

  async onError(ctx: StepErrorContext): Promise<HookControl | undefined> {
    for (const p of this.plugins) {
      const out = await safeCall(p, 'onStepError', ctx);
      if (out && (out.pause || out.nextLabel)) return out;
    }
    return undefined;
  }

  async onRetry(ctx: StepRetryContext) {
    for (const p of this.plugins) await safeCall(p, 'onRetry', ctx);
  }

  async onChooseNextLabel(ctx: StepContext & { suggested?: string }): Promise<string | undefined> {
    for (const p of this.plugins) {
      const out = await safeCall(p, 'onChooseNextLabel', ctx);
      if (out && out.nextLabel) return String(out.nextLabel);
    }
    return undefined;
  }

  async subflowStart(ctx: SubflowContext) {
    for (const p of this.plugins) await safeCall(p, 'onSubflowStart', ctx);
  }

  async subflowEnd(ctx: SubflowContext) {
    for (const p of this.plugins) await safeCall(p, 'onSubflowEnd', ctx);
  }

  async runEnd(ctx: RunEndContext) {
    for (const p of this.plugins) await safeCall(p, 'onRunEnd', ctx);
  }
}

async function safeCall<T extends keyof RunPlugin>(plugin: RunPlugin, key: T, arg: any) {
  try {
    const fn = plugin[key] as any;
    if (typeof fn === 'function') return await fn.call(plugin, arg);
  } catch (e) {
    // swallow plugin errors to keep core stable
    // console.warn(`[plugin:${plugin.name}] ${String(key)} error:`, e);
  }
  return undefined;
}
