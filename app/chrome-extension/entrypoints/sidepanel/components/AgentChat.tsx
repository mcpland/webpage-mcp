import { useEffect, useRef, useState } from 'react';
import { computed, ref, watch } from '@/entrypoints/shared/reactivity';
import type {
  AgentManagementInfo,
  AgentMessage,
  AgentStoredMessage,
  CodexReasoningEffort,
  OpenProjectTarget,
} from 'webpage-mcp-shared';

import {
  useAgentServer,
  useAgentChat,
  useAgentProjects,
  useAgentSessions,
  useAttachments,
  useAgentTheme,
  useAgentThreads,
  useWebEditorTxState,
  useAgentChatViewRoute,
  useOpenProjectPreference,
  useAgentInputPreferences,
  type AgentThemeId,
} from '../composables';
import type { SessionSettings } from './agent-chat/AgentSessionSettingsPanel';
import AgentChatViewReact from './AgentChatView';

import {
  getModelsForCli,
  getCodexReasoningEfforts,
  getDefaultModelForCli,
} from '@/common/agent-models';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { requestAgentRpcJson } from '@/utils/agent-rpc';
import { getMessage } from '@/utils/i18n';

type AgentCli = 'claude' | 'codex' | 'cursor' | 'qwen' | 'glm';

function createAgentChatController() {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);

  // Local UI state
  const selectedCli = ref('');
  const model = ref('');
  const reasoningEffort = ref<CodexReasoningEffort>('medium');
  const enableWebpageMcp = ref(true);
  const isSavingPreference = ref(false);

  /**
   * Get normalized model value that is valid for the current CLI.
   * Returns empty string if:
   * - No CLI selected (use server default)
   * - Model is invalid for selected CLI
   */
  function getNormalizedModel(): string {
    const trimmedModel = model.value.trim();
    if (!trimmedModel) return '';
    // No CLI selected = don't override model, let server use default
    if (!selectedCli.value) return '';
    const models = getModelsForCli(selectedCli.value);
    if (models.length === 0) return ''; // Unknown CLI
    const isValid = models.some((m) => m.id === trimmedModel);
    return isValid ? trimmedModel : '';
  }

  /**
   * Get normalized reasoning effort that is valid for the current model.
   * Used when creating/updating codex sessions.
   */
  function getNormalizedReasoningEffort(): CodexReasoningEffort {
    if (selectedCli.value !== 'codex') return 'medium';
    const effectiveModel = getNormalizedModel() || getDefaultModelForCli('codex');
    const supported = getCodexReasoningEfforts(effectiveModel);
    return supported.includes(reasoningEffort.value)
      ? reasoningEffort.value
      : (supported[supported.length - 1] as CodexReasoningEffort);
  }

  const isPickingDirectory = ref(false);
  const projectMenuOpen = ref(false);
  const sessionMenuOpen = ref(false);
  const settingsMenuOpen = ref(false);
  const openProjectMenuOpen = ref(false);

  // Open project context: which session/project to open when menu selects
  const openProjectContext = ref<{ type: 'session' | 'project'; id: string } | null>(null);

  // Session settings panel state
  const sessionSettingsOpen = ref(false);
  const sessionSettingsLoading = ref(false);
  const sessionSettingsSaving = ref(false);
  const currentManagementInfo = ref<AgentManagementInfo | null>(null);

  // Attachment cache panel state
  const attachmentCacheOpen = ref(false);

  // View routing (sessions list vs chat conversation)
  const viewRoute = useAgentChatViewRoute();

  // Intentionally declared first to break circular composable dependency wiring.
  // They are initialized immediately below in a fixed order.
  // eslint-disable-next-line prefer-const
  let server!: ReturnType<typeof useAgentServer>;
  // eslint-disable-next-line prefer-const
  let chat!: ReturnType<typeof useAgentChat>;
  // eslint-disable-next-line prefer-const
  let projects!: ReturnType<typeof useAgentProjects>;

  // Initialize composables - sessions must be declared first for sessionId access
  const sessions = useAgentSessions({
    ensureServer: () => server.ensureNativeServer(),
    onSessionChanged: (sessionId: string) => {
      // Guard against stale callbacks from concurrent session switches
      // This prevents race conditions where an older switch completes after a newer one
      if (sessionId !== sessions.selectedSessionId.value) {
        return;
      }

      // Always clear request state when session changes, regardless of view
      // This prevents stale cancel targets and running badges from carrying over
      chat.currentRequestId.value = null;
      chat.isStreaming.value = false;
      chat.requestState.value = 'idle';

      // Always sync URL when session changes (for all paths: delete, project switch, etc.)
      // This ensures URL stays consistent for refresh/deep-link scenarios
      viewRoute.setSessionId(sessionId);

      // Only reconnect SSE and reload history if we're in chat view
      // This prevents duplicate connections when switching sessions from the list
      // The list->chat navigation handlers will open SSE themselves
      if (viewRoute.isChatView.value && projects.selectedProjectId.value) {
        server.openEventSource();
        void loadSessionHistory(sessionId);
      }
    },
  });

  server = useAgentServer({
    getSessionId: () => sessions.selectedSessionId.value,
    onMessage: (event) => chat.handleRealtimeEvent(event),
    onError: (error) => {
      chat.errorMessage.value = error;
    },
    manualLifecycle: true,
  });

  chat = useAgentChat({
    getSessionId: () => sessions.selectedSessionId.value,
    ensureServer: () => server.ensureNativeServer(),
    openEventSource: () => server.openEventSource(),
  });

  projects = useAgentProjects({
    ensureServer: () => server.ensureNativeServer(),
    onHistoryLoaded: (messages: AgentStoredMessage[]) => {
      const converted = convertStoredMessages(messages);
      chat.setMessages(converted);
    },
  });

  const attachments = useAttachments();
  const themeState = useAgentTheme();
  const openProjectPreference = useOpenProjectPreference({
    ensureServer: () => server.ensureNativeServer(),
  });
  const inputPreferences = useAgentInputPreferences();

  // Initialize Web Editor TX state at root level and provide to children
  // This prevents duplicate listener registration in child components
  const webEditorTxState = useWebEditorTxState({
    manualLifecycle: true,
  });

  // Track running sessions for badge display
  const runningSessionIds = computed(() => {
    // For now, only track current session's running state
    // Could be extended to track multiple sessions via background broadcast
    const currentId = sessions.selectedSessionId.value;
    // Use isRequestActive instead of isStreaming to correctly show running badge
    // even during tool execution when isStreaming might be false
    if (currentId && chat.isRequestActive.value) {
      return new Set([currentId]);
    }
    return new Set<string>();
  });

  // Map of projectId -> AgentProject for looking up project info in sessions list
  const projectsMap = computed(() => {
    return new Map(projects.projects.value.map((p) => [p.id, p] as const));
  });

  // Thread state for grouping messages
  const threadState = useAgentThreads({
    messages: chat.messages,
    requestState: chat.requestState,
    currentRequestId: chat.currentRequestId,
  });

  // Computed values
  const projectLabel = computed(() => {
    const project = projects.selectedProject.value;
    return project?.name ?? 'No project';
  });

  const sessionLabel = computed(() => {
    const session = sessions.selectedSession.value;
    // Priority: preview (first user message) > name > 'New Session'
    return session?.preview || session?.name || 'New Session';
  });

  const connectionState = computed((): 'ready' | 'connecting' | 'disconnected' => {
    if (server.isServerReady.value) return 'ready';
    if (server.nativeConnected.value) return 'connecting';
    return 'disconnected';
  });

  // Computed values for AgentComposer
  const currentEngineName = computed(() => sessions.selectedSession.value?.engineName ?? '');

  // Engine display name for brand/footer
  const engineDisplayName = computed(() => {
    const name = currentEngineName.value;
    switch (name) {
      case 'claude':
        return 'Claude Code';
      case 'codex':
        return 'Codex';
      case 'cursor':
        return 'Cursor';
      case 'qwen':
        return 'Qwen';
      case 'glm':
        return 'GLM';
      default:
        return 'Agent';
    }
  });

  const currentSessionModel = computed(() => {
    const session = sessions.selectedSession.value;
    if (!session) return '';
    // Use session model if set, otherwise use default for the engine
    return session.model || getDefaultModelForCli(session.engineName);
  });

  const currentAvailableModels = computed(() => {
    const session = sessions.selectedSession.value;
    if (!session) return [];
    return getModelsForCli(session.engineName);
  });

  const currentReasoningEffort = computed(() => {
    const session = sessions.selectedSession.value;
    if (!session || session.engineName !== 'codex') return 'medium' as CodexReasoningEffort;
    return session.optionsConfig?.codexConfig?.reasoningEffort ?? 'medium';
  });

  const currentAvailableReasoningEfforts = computed(() => {
    const session = sessions.selectedSession.value;
    if (!session || session.engineName !== 'codex') return [] as readonly CodexReasoningEffort[];
    const effectiveModel = currentSessionModel.value || getDefaultModelForCli('codex');
    return getCodexReasoningEfforts(effectiveModel);
  });

  // Track pending history load with nonce to prevent A→B→A race conditions
  let historyLoadNonce = 0;

  /**
   * Load chat history for a specific session with race-condition protection.
   * Uses a nonce to handle A→B→A scenarios where older requests for the same
   * session could return after newer ones.
   */
  async function loadSessionHistory(sessionId: string): Promise<void> {
    if (!sessionId) return;

    // Increment nonce for this load - any subsequent load will invalidate this one
    const myNonce = ++historyLoadNonce;

    /**
     * Check if this load is still valid.
     * Validates both the nonce (handles A→B→A) and current selection (handles switches).
     */
    const isStillValid = (): boolean => {
      return myNonce === historyLoadNonce && sessions.selectedSessionId.value === sessionId;
    };

    try {
      const data = await requestAgentRpcJson<{ messages?: AgentStoredMessage[] }>({
        operation: 'agent.sessions.history',
        params: { sessionId },
      });

      if (!isStillValid()) return;

      // Re-check after json parsing (parsing can be slow for large histories)
      if (!isStillValid()) return;

      const messages = data.messages || [];
      const converted = convertStoredMessages(messages);
      chat.setMessages(converted);
    } catch (error) {
      if (isStillValid()) {
        console.error('Failed to load session history:', error);
        chat.setMessages([]);
      }
    }
  }

  // Convert stored messages to AgentMessage format
  function convertStoredMessages(stored: AgentStoredMessage[]): AgentMessage[] {
    return stored.map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      role: m.role,
      content: m.content,
      messageType: m.messageType,
      cliSource: m.cliSource ?? undefined,
      requestId: m.requestId,
      createdAt: m.createdAt ?? new Date().toISOString(),
      metadata: m.metadata,
    }));
  }

  /**
   * Clear streaming/request state when switching sessions.
   * Prevents stale cancel targets and running badges from carrying over.
   */
  function clearRequestState(): void {
    chat.currentRequestId.value = null;
    chat.isStreaming.value = false;
    chat.requestState.value = 'idle';
  }

  // Menu handlers
  function toggleProjectMenu(): void {
    projectMenuOpen.value = !projectMenuOpen.value;
    if (projectMenuOpen.value) {
      sessionMenuOpen.value = false;
      settingsMenuOpen.value = false;
      openProjectMenuOpen.value = false;
    }
  }

  function toggleSessionMenu(): void {
    sessionMenuOpen.value = !sessionMenuOpen.value;
    if (sessionMenuOpen.value) {
      projectMenuOpen.value = false;
      settingsMenuOpen.value = false;
      openProjectMenuOpen.value = false;
    }
  }

  function toggleSettingsMenu(): void {
    settingsMenuOpen.value = !settingsMenuOpen.value;
    if (settingsMenuOpen.value) {
      projectMenuOpen.value = false;
      sessionMenuOpen.value = false;
      openProjectMenuOpen.value = false;
    }
  }

  function toggleOpenProjectMenu(): void {
    openProjectMenuOpen.value = !openProjectMenuOpen.value;
    if (openProjectMenuOpen.value) {
      projectMenuOpen.value = false;
      sessionMenuOpen.value = false;
      settingsMenuOpen.value = false;
      // Set context to current session from chat view
      const sessionId = sessions.selectedSessionId.value;
      if (sessionId) {
        openProjectContext.value = { type: 'session', id: sessionId };
      }
    } else {
      openProjectContext.value = null;
    }
  }

  function closeOpenProjectMenu(): void {
    openProjectMenuOpen.value = false;
    openProjectContext.value = null;
  }

  /**
   * Handle session list item's open-project button click.
   * If user has a default preference, open directly; otherwise show menu.
   */
  async function handleSessionOpenProject(sessionId: string): Promise<void> {
    const defaultTarget = openProjectPreference.defaultTarget.value;
    if (defaultTarget) {
      // User has default preference, open directly
      const result = await openProjectPreference.openBySession(sessionId, defaultTarget);
      if (!result.success) {
        alert(
          t('agentOpenProjectFailed', 'Failed to open project: {0}', [
            String(result.error || t('unknownErrorMessage', 'Unknown error')),
          ]),
        );
      }
    } else {
      // No default, show menu
      openProjectContext.value = { type: 'session', id: sessionId };
      openProjectMenuOpen.value = true;
      projectMenuOpen.value = false;
      sessionMenuOpen.value = false;
      settingsMenuOpen.value = false;
    }
  }

  /**
   * Handle open project menu selection.
   * Saves preference and opens the project.
   */
  async function handleOpenProjectSelect(target: OpenProjectTarget): Promise<void> {
    // Snapshot context before any await to prevent race condition
    // (close event may clear context while we're awaiting)
    const ctx = openProjectContext.value;

    // Close menu immediately for better UX
    closeOpenProjectMenu();

    if (!ctx) return;

    // Save as default preference (non-blocking for UX)
    void openProjectPreference.saveDefaultTarget(target);

    // Execute open action based on context
    let result;
    if (ctx.type === 'session') {
      result = await openProjectPreference.openBySession(ctx.id, target);
    } else {
      result = await openProjectPreference.openByProject(ctx.id, target);
    }

    if (!result.success) {
      alert(
        t('agentOpenProjectFailed', 'Failed to open project: {0}', [
          String(result.error || t('unknownErrorMessage', 'Unknown error')),
        ]),
      );
    }
  }

  function closeMenus(): void {
    projectMenuOpen.value = false;
    sessionMenuOpen.value = false;
    settingsMenuOpen.value = false;
    openProjectMenuOpen.value = false;
    openProjectContext.value = null;
  }

  // Theme handler
  async function handleThemeChange(theme: AgentThemeId): Promise<void> {
    await themeState.setTheme(theme);
    closeMenus();
  }

  // Fake caret toggle handler
  async function handleFakeCaretToggle(enabled: boolean): Promise<void> {
    await inputPreferences.setFakeCaretEnabled(enabled);
  }

  // Server reconnect
  async function handleReconnect(): Promise<void> {
    closeMenus();
    await server.reconnect();
  }

  // Attachment cache handlers
  function handleOpenAttachmentCache(): void {
    attachmentCacheOpen.value = true;
    sessionSettingsOpen.value = false;
    closeMenus();
  }

  function handleCloseAttachmentCache(): void {
    attachmentCacheOpen.value = false;
  }

  // Session handlers
  async function handleSessionSelect(sessionId: string): Promise<void> {
    await sessions.selectSession(sessionId);
    // Note: URL sync is handled by onSessionChanged callback
    closeMenus();
  }

  async function handleNewSession(): Promise<void> {
    const projectId = projects.selectedProjectId.value;
    if (!projectId) return;

    // Clear previous request state (in chat view, creating new session should reset state)
    clearRequestState();

    const engineName = (selectedCli.value as AgentCli) || 'claude';

    // Include codex config if using codex engine
    const optionsConfig =
      engineName === 'codex'
        ? {
            codexConfig: {
              reasoningEffort: getNormalizedReasoningEffort(),
            },
          }
        : undefined;

    const session = await sessions.createSession(projectId, {
      engineName,
      name: `Session ${sessions.sessions.value.length + 1}`,
      optionsConfig,
    });

    // Guard: only clear messages if the new session is still selected
    // This prevents clearing messages if user switched during createSession await
    if (session && sessions.selectedSessionId.value === session.id) {
      chat.setMessages([]);
      // Note: URL sync is handled by onSessionChanged callback (triggered by createSession)
    }
    closeMenus();
  }

  async function handleDeleteSession(sessionId: string): Promise<void> {
    const wasCurrentSession = sessions.selectedSessionId.value === sessionId;
    const wasInChatView = viewRoute.isChatView.value;

    await sessions.deleteSession(sessionId);

    // Handle post-delete navigation and URL sync
    if (wasCurrentSession) {
      if (sessions.sessions.value.length === 0) {
        // No sessions left - go back to sessions list (will show empty state)
        // Also clear URL sessionId since there's no valid session
        viewRoute.setSessionId(null);
        if (wasInChatView) {
          viewRoute.goToSessions();
        }
      }
      // Note: If there are remaining sessions, useAgentSessions.deleteSession
      // already calls onSessionChanged which syncs URL via setSessionId
    }
  }

  async function handleRenameSession(sessionId: string, name: string): Promise<void> {
    await sessions.renameSession(sessionId, name);
  }

  async function handleOpenSessionSettings(sessionId: string): Promise<void> {
    closeMenus();
    sessionSettingsOpen.value = true;
    sessionSettingsLoading.value = true;
    currentManagementInfo.value = null;

    try {
      // Fetch Claude SDK management info if this is a Claude session
      const session = sessions.sessions.value.find((s) => s.id === sessionId);
      if (session?.engineName === 'claude') {
        const info = await sessions.fetchClaudeInfo(sessionId);
        if (info) {
          currentManagementInfo.value = info.managementInfo;
        }
      }
    } finally {
      sessionSettingsLoading.value = false;
    }
  }

  async function handleResetSession(sessionId: string): Promise<void> {
    closeMenus();
    const result = await sessions.resetConversation(sessionId);
    // Guard: only clear messages if the reset session is still selected
    // This prevents clearing messages if user switched during reset await
    if (result && sessions.selectedSessionId.value === sessionId) {
      chat.setMessages([]);
    }
  }

  // Composer direct model/reasoning effort change handlers
  async function handleComposerModelChange(modelId: string): Promise<void> {
    const sessionId = sessions.selectedSessionId.value;
    if (!sessionId) return;

    await sessions.updateSession(sessionId, { model: modelId || null });
  }

  async function handleComposerReasoningEffortChange(
    effort: CodexReasoningEffort,
  ): Promise<void> {
    const sessionId = sessions.selectedSessionId.value;
    const session = sessions.selectedSession.value;
    if (!sessionId || !session) return;

    const existingOptions = session.optionsConfig ?? {};
    const existingCodexConfig = existingOptions.codexConfig ?? {};
    await sessions.updateSession(sessionId, {
      optionsConfig: {
        ...existingOptions,
        codexConfig: {
          ...existingCodexConfig,
          reasoningEffort: effort,
        },
      },
    });
  }

  // Composer session settings/reset handlers (without sessionId parameter)
  function handleComposerOpenSettings(): void {
    const sessionId = sessions.selectedSessionId.value;
    if (sessionId) {
      void handleOpenSessionSettings(sessionId);
    }
  }

  async function handleComposerReset(): Promise<void> {
    const sessionId = sessions.selectedSessionId.value;
    if (sessionId) {
      await handleResetSession(sessionId);
    }
  }

  function handleCloseSessionSettings(): void {
    sessionSettingsOpen.value = false;
    currentManagementInfo.value = null;
  }

  async function handleSaveSessionSettings(settings: SessionSettings): Promise<void> {
    const sessionId = sessions.selectedSessionId.value;
    if (!sessionId) return;

    sessionSettingsSaving.value = true;
    try {
      await sessions.updateSession(sessionId, {
        model: settings.model || null,
        permissionMode: settings.permissionMode || null,
        systemPromptConfig: settings.systemPromptConfig,
        optionsConfig: settings.optionsConfig,
      });
      sessionSettingsOpen.value = false;
      currentManagementInfo.value = null;
    } finally {
      sessionSettingsSaving.value = false;
    }
  }

  // Project handlers
  async function handleProjectSelect(projectId: string): Promise<void> {
    // Clear request state and sessions before switching project
    // This prevents stale session data from mixing with the new project
    clearRequestState();
    sessions.clearSessions();

    projects.selectedProjectId.value = projectId;
    await projects.handleProjectChanged();

    // Guard: abort if user switched to a different project during await
    if (projects.selectedProjectId.value !== projectId) {
      closeMenus();
      return;
    }

    const project = projects.selectedProject.value;
    if (project) {
      selectedCli.value = project.preferredCli ?? '';
      model.value = project.selectedModel ?? '';
      enableWebpageMcp.value = project.enableWebpageMcp !== false;
    }
    // Load sessions for the new project
    await sessions.ensureDefaultSession(
      projectId,
      (selectedCli.value as AgentCli) || 'claude',
    );

    // Guard again after ensureDefaultSession
    if (projects.selectedProjectId.value !== projectId) {
      closeMenus();
      return;
    }

    // Ensure URL is synced after project switch (fallback for edge cases)
    // This handles rare cases where ensureDefaultSession doesn't trigger onSessionChanged
    viewRoute.setSessionId(sessions.selectedSessionId.value || null);

    closeMenus();
  }

  async function handleNewProject(): Promise<void> {
    isPickingDirectory.value = true;
    try {
      const path = await projects.pickDirectory();
      if (path) {
        // Extract directory name from path, handling trailing slashes
        const segments = path.split(/[/\\]/).filter((s) => s.length > 0);
        const dirName = segments.pop() || 'New Project';
        const project = await projects.createProjectFromPath(path, dirName);
        if (project) {
          selectedCli.value = project.preferredCli ?? '';
          model.value = project.selectedModel ?? '';
          enableWebpageMcp.value = project.enableWebpageMcp !== false;

          // Ensure a default session exists for the new project
          const engineName = (selectedCli.value as AgentCli) || 'claude';
          await sessions.ensureDefaultSession(project.id, engineName);

          // Reconnect SSE and load session history
          if (sessions.selectedSessionId.value) {
            server.openEventSource();
            await loadSessionHistory(sessions.selectedSessionId.value);
          }
        }
      }
    } finally {
      isPickingDirectory.value = false;
      closeMenus();
    }
  }

  async function handleSaveSettings(): Promise<void> {
    const project = projects.selectedProject.value;
    if (!project) return;

    // Capture previous CLI to detect changes
    const previousCli = project.preferredCli ?? '';

    isSavingPreference.value = true;
    try {
      // Use normalized model to ensure valid value is saved
      const normalizedModel = getNormalizedModel();
      await projects.saveProjectPreference(selectedCli.value, normalizedModel, enableWebpageMcp.value);
      // Sync local state with normalized values
      model.value = normalizedModel;

      // If CLI changed, create a new empty session with the new CLI
      const cliChanged = previousCli !== selectedCli.value;
      if (cliChanged && selectedCli.value) {
        const engineName = selectedCli.value as AgentCli;

        // Include codex config if using codex engine
        const optionsConfig =
          engineName === 'codex'
            ? {
                codexConfig: {
                  reasoningEffort: getNormalizedReasoningEffort(),
                },
              }
            : undefined;

        const session = await sessions.createSession(project.id, {
          engineName,
          name: `Session ${sessions.sessions.value.length + 1}`,
          optionsConfig,
        });

        // Guard: only clear messages if the new session is still selected
        // This prevents clearing messages if user switched during createSession await
        if (session && sessions.selectedSessionId.value === session.id) {
          chat.setMessages([]);
        }
      }
    } finally {
      isSavingPreference.value = false;
      closeMenus();
    }
  }

  // =============================================================================
  // View Navigation
  // =============================================================================

  /**
   * Handle session selection from sessions list and navigate to chat view.
   * Supports cross-project selection: if the selected session belongs to a different
   * project, the project context will be switched automatically.
   */
  async function handleSessionSelectAndNavigate(sessionId: string): Promise<void> {
    // Only clear request state when switching to a DIFFERENT session
    // If re-entering the same session, preserve the running state
    // (e.g., user exits to list and comes back while request is still running)
    const isSameSession = sessions.selectedSessionId.value === sessionId;
    if (!isSameSession) {
      clearRequestState();
    }

    // Find the session's projectId from allSessions, fallback to API if not found
    const targetProjectId =
      sessions.allSessions.value.find((s) => s.id === sessionId)?.projectId ??
      (await sessions.getSession(sessionId))?.projectId;

    if (!targetProjectId) {
      console.warn('[AgentChat] Unable to resolve projectId for session:', sessionId);
      return;
    }

    // If the session belongs to a different project, switch project context first
    if (projects.selectedProjectId.value !== targetProjectId) {
      // Clear sessions before switching to prevent stale data mixing
      sessions.clearSessions();
      projects.selectedProjectId.value = targetProjectId;
      await projects.handleProjectChanged();

      // Guard: abort if user switched to a different project during await
      if (projects.selectedProjectId.value !== targetProjectId) {
        return;
      }

      // Sync local UI state with the new project's preferences
      const project = projects.selectedProject.value;
      if (project) {
        selectedCli.value = project.preferredCli ?? '';
        model.value = project.selectedModel ?? '';
        enableWebpageMcp.value = project.enableWebpageMcp !== false;
      }

      // Fetch sessions for the new project
      await sessions.fetchSessions(targetProjectId);

      // Guard again after fetchSessions
      if (projects.selectedProjectId.value !== targetProjectId) {
        return;
      }
    }

    await sessions.selectSession(sessionId);

    // Guard against stale navigation if user switched to a different session during await
    if (sessions.selectedSessionId.value !== sessionId) {
      return;
    }

    viewRoute.goToChat(sessionId);

    // Open SSE and load history when entering chat view
    server.openEventSource();
    await loadSessionHistory(sessionId);
  }

  /**
   * Create a new session and navigate to chat view.
   */
  async function handleNewSessionAndNavigate(): Promise<void> {
    if (!projects.selectedProjectId.value) return;

    // Clear previous state before creating new session
    clearRequestState();

    const engineName = (selectedCli.value as AgentCli) || 'claude';
    const optionsConfig =
      engineName === 'codex'
        ? {
            codexConfig: {
              reasoningEffort: getNormalizedReasoningEffort(),
            },
          }
        : undefined;

    const session = await sessions.createSession(projects.selectedProjectId.value, {
      engineName,
      name: `Session ${sessions.sessions.value.length + 1}`,
      optionsConfig,
    });

    // Guard against stale navigation if user switched during createSession await
    if (session && sessions.selectedSessionId.value === session.id) {
      chat.setMessages([]);
      viewRoute.goToChat(session.id);

      // Open SSE for new session
      server.openEventSource();
    }
  }

  /**
   * Navigate back to sessions list.
   */
  function handleBackToSessions(): void {
    viewRoute.goToSessions();
  }

  // =============================================================================
  // Web Editor Selection Context
  // =============================================================================

  /**
   * Build instruction with web editor selection context prepended.
   * This provides AI with element context when user asks to modify selected element.
   *
   * Format:
   * ```
   * [WebEditorSelectionContext]
   * pageUrl: <pageUrl>
   * tagName: <tagName>
   * label: <label>
   * selectors: [<up to 3>]
   * fingerprint: <fingerprint>
   *
   * [UserRequest]
   * <user original input>
   * ```
   *
   * @param userInput - The user's original input text
   * @returns Instruction with context prepended, or original input if no selection
   */
  function buildInstructionWithSelectionContext(userInput: string): string {
    const selection = webEditorTxState.selectedElement.value;
    const txState = webEditorTxState.txState.value;
    const selectionPageUrl = webEditorTxState.selectionPageUrl.value;

    // No selection = return original input
    if (!selection) {
      return userInput;
    }

    // Build context lines
    const contextLines: string[] = ['[WebEditorSelectionContext]'];

    // Page URL - prefer selection's pageUrl (more recent), fall back to txState
    const pageUrl = selectionPageUrl || txState?.pageUrl;
    if (pageUrl) {
      contextLines.push(`pageUrl: ${pageUrl}`);
    }

    // Element key for stable identification
    if (selection.elementKey) {
      contextLines.push(`elementKey: ${selection.elementKey}`);
    }

    // Element info
    contextLines.push(`tagName: ${selection.tagName || 'unknown'}`);
    contextLines.push(`label: ${selection.label || selection.fullLabel || 'unknown'}`);

    // Selectors (up to 3)
    const selectors = selection.locator?.selectors ?? [];
    const topSelectors = selectors.slice(0, 3);
    if (topSelectors.length > 0) {
      contextLines.push(`selectors: [${topSelectors.map((s) => `"${s}"`).join(', ')}]`);
    }

    // Fingerprint for similarity matching
    if (selection.locator?.fingerprint) {
      contextLines.push(`fingerprint: ${selection.locator.fingerprint}`);
    }

    // Combine context with user request
    return `${contextLines.join('\n')}\n\n[UserRequest]\n${userInput}`;
  }

  // Attachment handlers
  function handleAttachmentAdd(): void {
    // Create and click a hidden file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = (event) => {
      void attachments.handleFileSelect(event);
    };
    input.click();
  }

  // Send handler
  async function handleSend(): Promise<void> {
    const dbSessionId = sessions.selectedSessionId.value;
    if (!dbSessionId) {
      chat.errorMessage.value = 'No session selected.';
      return;
    }

    // Capture input before clearing for preview update
    const messageText = chat.input.value.trim();
    if (!messageText) return;

    // Check if user has selected an element in web editor
    const selection = webEditorTxState.selectedElement.value;
    const txState = webEditorTxState.txState.value;
    const selectionPageUrl = webEditorTxState.selectionPageUrl.value;

    // Capture selection info before sending (for clear after success)
    const selectionTabId = webEditorTxState.tabId.value;
    const selectionElementKey = selection?.elementKey ?? null;

    // When a web editor element is selected, store structured metadata on the user message
    // so the thread header can render as a chip (same style as "Web editor apply")
    const selectionClientMeta = selection
      ? {
          kind: 'web_editor_apply_single' as const,
          pageUrl: selectionPageUrl || txState?.pageUrl || 'unknown',
          elementCount: 1,
          elementLabels: [
            selection.label || selection.fullLabel || selection.tagName || 'selected element',
          ],
        }
      : undefined;

    // Build instruction with web editor selection context (if any)
    // The UI will show the original messageText, but the actual instruction
    // sent to the server will include element context for AI to understand
    const instructionWithContext = buildInstructionWithSelectionContext(messageText);

    // Use getAttachments() to strip previewUrl and avoid payload bloat
    chat.attachments.value = attachments.getAttachments() ?? [];

    // Session-level config is now used by backend; no need to pass cliPreference/model
    // For selection context messages, use the user's input as displayText
    // so the chip shows meaningful content instead of a generic label
    await chat.send({
      projectId: projects.selectedProjectId.value || undefined,
      dbSessionId,
      // Pass the context-enriched instruction to be sent to server
      instruction: instructionWithContext,
      // Attach metadata only when selection context exists
      // Use user's original message as displayText for better UX
      displayText: selection ? messageText : undefined,
      clientMeta: selectionClientMeta,
    });

    // Clear web editor selection after successful send
    // This "consumes" the selection context so it won't be re-injected in next message
    if (selectionElementKey && selectionTabId) {
      // Check if user has selected a DIFFERENT element during the loading period
      // Compare both elementKey AND tabId to handle cross-tab scenarios
      // (elementKey like "div#app" is not unique across tabs/pages)
      const currentElementKey = webEditorTxState.selectedElement.value?.elementKey ?? null;
      const currentTabId = webEditorTxState.tabId.value;

      const isSameSelection =
        currentElementKey === selectionElementKey && currentTabId === selectionTabId;

      if (!isSameSelection && currentElementKey !== null) {
        // User selected a new element (or switched tab) during send - preserve it, don't clear
      } else {
        // Same element or already deselected - proceed with clear
        // Try to clear via message (web-editor may be open)
        chrome.runtime
          .sendMessage({
            type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CLEAR_SELECTION,
            payload: { tabId: selectionTabId },
          })
          .then((response: { success: boolean } | undefined) => {
            // If web-editor didn't respond (closed/not active), clear local state
            // Use captured selectionTabId/selectionElementKey to avoid clearing new selection
            if (!response?.success) {
              clearLocalSelectionState(selectionTabId, selectionElementKey);
            }
            // If success, web-editor will broadcast null selection which will clear our state
          })
          .catch(() => {
            // Message failed - clear sidepanel local state directly
            clearLocalSelectionState(selectionTabId, selectionElementKey);
          });
      }
    }

    // Update session preview with first user message (if not already set)
    // Note: Use original messageText, not the context-enriched version
    // Include previewMeta for special chip rendering in session list
    sessions.updateSessionPreview(
      dbSessionId,
      messageText,
      selectionClientMeta
        ? {
            displayText: messageText,
            clientMeta: selectionClientMeta,
            fullContent: instructionWithContext,
          }
        : undefined,
    );

    attachments.clearAttachments();
  }

  /**
   * Clear sidepanel local selection state.
   * Used when web-editor is closed or unreachable.
   *
   * @param expectedTabId - The tab ID that was selected at send time
   * @param expectedElementKey - The element key that was selected at send time
   */
  function clearLocalSelectionState(expectedTabId: number, expectedElementKey: string): void {
    // Double-check we're still on the same selection to avoid clearing new selection
    const currentTabId = webEditorTxState.tabId.value;
    const currentElementKey = webEditorTxState.selectedElement.value?.elementKey ?? null;

    // Only clear if still pointing to the same selection (or already cleared)
    const shouldClear =
      currentElementKey === null ||
      (currentTabId === expectedTabId && currentElementKey === expectedElementKey);

    if (!shouldClear) {
      // User switched to a different selection - don't clear
      return;
    }

    // Clear the reactive state
    webEditorTxState.selectedElement.value = null;
    webEditorTxState.selectionPageUrl.value = null;

    // Clear session storage to prevent "revival" on refresh/tab switch
    if (expectedTabId) {
      const storageKey = `web-editor-v2-selection-${expectedTabId}`;
      chrome.storage.session.remove(storageKey).catch(() => {
        // Ignore storage errors
      });
    }
  }

  const viewProps = computed(() => ({
    theme: themeState.theme.value,
    isSessionsView: viewRoute.isSessionsView.value,
    allSessions: sessions.allSessions.value,
    selectedSessionId: sessions.selectedSessionId.value || '',
    isLoadingAllSessions: sessions.isLoadingAllSessions.value,
    isCreatingSession: sessions.isCreatingSession.value,
    sessionError: sessions.sessionError.value,
    runningSessionIds: runningSessionIds.value,
    projectsMap: projectsMap.value,
    onSessionSelectAndNavigate: handleSessionSelectAndNavigate,
    onSessionNewAndNavigate: handleNewSessionAndNavigate,
    onDeleteSession: handleDeleteSession,
    onRenameSession: handleRenameSession,
    onSessionOpenProject: handleSessionOpenProject,

    chatErrorMessage: chat.errorMessage.value,
    usage: chat.lastUsage.value,
    footerLabel: `${engineDisplayName.value} Preview`,
    onDismissError: () => {
      chat.errorMessage.value = null;
    },

    projectLabel: projectLabel.value,
    sessionLabel: sessionLabel.value,
    connectionState: connectionState.value,
    engineDisplayName: engineDisplayName.value,
    threads: threadState.threads.value,
    serverPort: server.serverPort.value,
    webEditorTxState,

    inputValue: chat.input.value,
    attachments: attachments.attachments.value,
    attachmentError: attachments.error.value,
    isDragOver: attachments.isDragOver.value,
    isStreaming: chat.isStreaming.value,
    requestState: chat.requestState.value,
    sending: chat.sending.value,
    cancelling: chat.cancelling.value,
    canCancel: !!chat.currentRequestId.value,
    canSend: chat.canSend.value,
    currentEngineName: currentEngineName.value,
    currentSessionModel: currentSessionModel.value,
    currentAvailableModels: currentAvailableModels.value,
    currentReasoningEffort: currentReasoningEffort.value,
    currentAvailableReasoningEfforts: currentAvailableReasoningEfforts.value,
    fakeCaretEnabled: inputPreferences.fakeCaretEnabled.value,
    onInputChange: (value: string) => {
      chat.input.value = value;
    },
    onSend: handleSend,
    onCancelRequest: () => {
      void chat.cancelCurrentRequest();
    },
    onAttachmentAdd: handleAttachmentAdd,
    onAttachmentRemove: attachments.removeAttachment,
    onAttachmentDrop: attachments.handleDrop,
    onAttachmentPaste: attachments.handlePaste,
    onAttachmentDragOver: attachments.handleDragOver,
    onAttachmentDragLeave: attachments.handleDragLeave,
    onComposerModelChange: handleComposerModelChange,
    onComposerReasoningEffortChange: handleComposerReasoningEffortChange,
    onComposerOpenSettings: handleComposerOpenSettings,
    onComposerReset: handleComposerReset,

    projectMenuOpen: projectMenuOpen.value,
    sessionMenuOpen: sessionMenuOpen.value,
    settingsMenuOpen: settingsMenuOpen.value,
    openProjectMenuOpen: openProjectMenuOpen.value,
    selectedProjectId: projects.selectedProjectId.value || '',
    projects: projects.projects.value,
    selectedCli: selectedCli.value,
    model: model.value,
    reasoningEffort: reasoningEffort.value,
    enableWebpageMcp: enableWebpageMcp.value,
    engines: server.engines.value,
    isPickingDirectory: isPickingDirectory.value,
    isSavingPreference: isSavingPreference.value,
    projectError: projects.projectError.value,
    onToggleProjectMenu: toggleProjectMenu,
    onToggleSessionMenu: toggleSessionMenu,
    onToggleSettingsMenu: toggleSettingsMenu,
    onToggleOpenProjectMenu: toggleOpenProjectMenu,
    onBackToSessions: handleBackToSessions,
    onCloseMenus: closeMenus,
    onProjectSelect: handleProjectSelect,
    onNewProject: handleNewProject,
    onCliUpdate: (value: string) => {
      selectedCli.value = value;
    },
    onModelUpdate: (value: string) => {
      model.value = value;
    },
    onReasoningEffortUpdate: (value: CodexReasoningEffort) => {
      reasoningEffort.value = value;
    },
    onWebpageMcpUpdate: (value: boolean) => {
      enableWebpageMcp.value = value;
    },
    onSaveSettings: handleSaveSettings,

    projectSessions: sessions.sessions.value,
    isLoadingSessions: sessions.isLoadingSessions.value,
    onSessionSelect: handleSessionSelect,
    onNewSession: handleNewSession,

    onThemeSet: handleThemeChange,
    onReconnect: handleReconnect,
    onAttachmentsOpen: handleOpenAttachmentCache,
    onFakeCaretToggle: handleFakeCaretToggle,

    defaultOpenProjectTarget: openProjectPreference.defaultTarget.value,
    onOpenProjectSelect: handleOpenProjectSelect,
    onCloseOpenProjectMenu: closeOpenProjectMenu,

    sessionSettingsOpen: sessionSettingsOpen.value,
    selectedSession: sessions.selectedSession.value,
    currentManagementInfo: currentManagementInfo.value,
    sessionSettingsLoading: sessionSettingsLoading.value,
    sessionSettingsSaving: sessionSettingsSaving.value,
    onCloseSessionSettings: handleCloseSessionSettings,
    onSaveSessionSettings: handleSaveSessionSettings,

    attachmentCacheOpen: attachmentCacheOpen.value,
    onCloseAttachmentCache: handleCloseAttachmentCache,
  }));

  // Initialize
  async function initialize(): Promise<void> {
    // Initialize Web Editor TX state listeners in manual lifecycle mode
    await webEditorTxState.initialize();

    // Initialize theme
    await themeState.initTheme();

    // Load open project preference
    await openProjectPreference.loadDefaultTarget();

    // Load input preferences (fake caret, etc.)
    await inputPreferences.init();

    // Initialize server
    await server.initialize();

    if (server.isServerReady.value) {
      // Ensure default project exists and load projects
      await projects.ensureDefaultProject();
      await projects.fetchProjects();

      // Load all sessions across all projects for the global sessions list view
      await sessions.fetchAllSessions();

      // Load selected project or use first one
      await projects.loadSelectedProjectId();
      const hasValidSelection =
        projects.selectedProjectId.value &&
        projects.projects.value.some((p) => p.id === projects.selectedProjectId.value);

      if (!hasValidSelection && projects.projects.value.length > 0) {
        projects.selectedProjectId.value = projects.projects.value[0].id;
        await projects.saveSelectedProjectId();
      }

      // Load settings and sessions
      if (projects.selectedProjectId.value) {
        const project = projects.selectedProject.value;
        if (project) {
          selectedCli.value = project.preferredCli ?? '';
          model.value = project.selectedModel ?? '';
          enableWebpageMcp.value = project.enableWebpageMcp !== false;
        }

        // Load sessions for the project
        await sessions.loadSelectedSessionId();
        await sessions.fetchSessions(projects.selectedProjectId.value);

        // Parse URL parameters to determine initial view
        // Note: This is called after fetchSessions so we can verify the session exists
        const initialRoute = viewRoute.initFromUrl();

        // Handle deep link: URL specifies session to open directly (e.g., from Apply)
        // Support cross-project sessions by checking allSessions first
        if (initialRoute.view === 'chat' && initialRoute.sessionId) {
          const targetSession =
            sessions.allSessions.value.find((s) => s.id === initialRoute.sessionId) ??
            sessions.sessions.value.find((s) => s.id === initialRoute.sessionId);

          if (targetSession) {
            // Use handleSessionSelectAndNavigate to handle cross-project switching
            await handleSessionSelectAndNavigate(targetSession.id);
          } else {
            // Session doesn't exist in any project, fall back to sessions list
            viewRoute.goToSessions();
          }
        }

        // Ensure a default session exists (for new users)
        // Note: This won't fetch sessions again since we already did above
        await sessions.ensureDefaultSession(
          projects.selectedProjectId.value,
          (selectedCli.value as AgentCli) || 'claude',
        );

        // Only open SSE and load history if we're in chat view with a valid session
        if (viewRoute.isChatView.value && sessions.selectedSessionId.value) {
          server.openEventSource();
          await loadSessionHistory(sessions.selectedSessionId.value);
        }
      }
    }
  }

  // Watch for server ready
  async function handleServerReadyChange(ready: boolean | undefined): Promise<void> {
    if (ready && projects.projects.value.length === 0) {
      await projects.ensureDefaultProject();
      await projects.fetchProjects();

      // Also fetch all sessions for the global sessions list
      await sessions.fetchAllSessions();

      const hasValidSelection =
        projects.selectedProjectId.value &&
        projects.projects.value.some((p) => p.id === projects.selectedProjectId.value);

      if (!hasValidSelection && projects.projects.value.length > 0) {
        projects.selectedProjectId.value = projects.projects.value[0].id;
        await projects.saveSelectedProjectId();
      }
    }
  }

  function dispose(): void {
    server.dispose();
    webEditorTxState.dispose();
  }

  return {
    viewProps,
    server,
    closeMenus,
    initialize,
    handleServerReadyChange,
    dispose,
  };
}

export default function AgentChat() {
  const [, forceRender] = useState(0);
  const controllerRef = useRef<ReturnType<typeof createAgentChatController> | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = createAgentChatController();
  }

  const controller = controllerRef.current;

  useEffect(() => {
    if (!controller) return;

    let disposed = false;

    const stopRenderWatch = watch(
      () => controller.viewProps.value,
      () => {
        if (!disposed) {
          forceRender((value) => value + 1);
        }
      },
      { deep: true },
    );

    const stopServerReadyWatch = watch(
      () => controller.server.isServerReady.value,
      (ready) => {
        void controller.handleServerReadyChange(ready);
      },
    );

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        controller.closeMenus();
      }
    };

    document.addEventListener('keydown', handleEscape);

    void controller.initialize();

    return () => {
      disposed = true;
      stopRenderWatch();
      stopServerReadyWatch();
      document.removeEventListener('keydown', handleEscape);
      controller.dispose();
    };
  }, [controller]);

  if (!controller) {
    return null;
  }

  return <AgentChatViewReact {...controller.viewProps.value} />;
}
