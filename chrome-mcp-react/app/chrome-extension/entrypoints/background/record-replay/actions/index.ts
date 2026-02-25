/**
 * Action System - 导出模块
 */

// 类型导出
export * from './types';

// 注册表导出
export {
  ActionRegistry,
  createActionRegistry,
  ok,
  invalid,
  failed,
  tryResolveString,
  tryResolveNumber,
  tryResolveJson,
  tryResolveValue,
  type BeforeExecuteArgs,
  type BeforeExecuteHook,
  type AfterExecuteArgs,
  type AfterExecuteHook,
  type ActionRegistryHooks,
} from './registry';

// 适配器导出
export {
  execCtxToActionCtx,
  stepToAction,
  actionResultToExecResult,
  createStepExecutor,
  isActionSupported,
  getActionType,
  type StepExecutionAttempt,
} from './adapter';

// Handler 工厂导出
export {
  createReplayActionRegistry,
  registerReplayHandlers,
  getSupportedActionTypes,
  isActionTypeSupported,
} from './handlers';
