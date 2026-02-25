/**
 * Agent Chat Composables
 * Export all composables for agent chat functionality.
 */
export { useAgentServer } from './useAgentServer';
export { useAgentChat } from './useAgentChat';
export { useAgentProjects } from './useAgentProjects';
export { useAgentSessions } from './useAgentSessions';
export { useAttachments, type AttachmentWithPreview } from './useAttachments';
export { useAgentTheme, preloadAgentTheme, THEME_LABELS } from './useAgentTheme';
export { useAgentThreads, AGENT_SERVER_PORT_KEY } from './useAgentThreads';
export { useWebEditorTxState, WEB_EDITOR_TX_STATE_INJECTION_KEY } from './useWebEditorTxState';
export { useAgentChatViewRoute } from './useAgentChatViewRoute';

export type { UseAgentServerOptions } from './useAgentServer';
export type { UseAgentChatOptions } from './useAgentChat';
export type { UseAgentProjectsOptions } from './useAgentProjects';
export type { UseAgentSessionsOptions } from './useAgentSessions';
export type { AgentThemeId, UseAgentTheme } from './useAgentTheme';
export type {
  AgentThread,
  TimelineItem,
  ToolPresentation,
  ToolKind,
  ToolSeverity,
  AgentThreadState,
  UseAgentThreadsOptions,
  ThreadHeader,
  WebEditorApplyMeta,
} from './useAgentThreads';
export type { UseWebEditorTxStateOptions, WebEditorTxStateReturn } from './useWebEditorTxState';
export type {
  AgentChatView,
  AgentChatRouteState,
  UseAgentChatViewRouteOptions,
  UseAgentChatViewRoute,
} from './useAgentChatViewRoute';

// RR V3 Composables
export { useRRV3Rpc } from './useRRV3Rpc';
export { useRRV3Debugger } from './useRRV3Debugger';
export type { UseRRV3Rpc, UseRRV3RpcOptions, RpcRequestOptions } from './useRRV3Rpc';
export type { UseRRV3Debugger, UseRRV3DebuggerOptions } from './useRRV3Debugger';

// Textarea Auto-Resize
export { useTextareaAutoResize } from './useTextareaAutoResize';
export type {
  UseTextareaAutoResizeOptions,
  UseTextareaAutoResizeReturn,
} from './useTextareaAutoResize';

// Fake Caret (comet tail animation)
export { useFakeCaret } from './useFakeCaret';
export type { UseFakeCaretOptions, UseFakeCaretReturn, FakeCaretTrailPoint } from './useFakeCaret';

// Open Project Preference
export { useOpenProjectPreference } from './useOpenProjectPreference';
export type {
  UseOpenProjectPreferenceOptions,
  UseOpenProjectPreference,
} from './useOpenProjectPreference';

// Agent Input Preferences (fake caret, etc.)
export { useAgentInputPreferences } from './useAgentInputPreferences';
export type { UseAgentInputPreferences } from './useAgentInputPreferences';
