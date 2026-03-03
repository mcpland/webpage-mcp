import { useEffect, useMemo, useState } from 'react';
import type {
  AgentManagementInfo,
  AgentSession,
  AgentSessionOptionsConfig,
  AgentSystemPromptConfig,
  CodexReasoningEffort,
} from 'webpage-mcp-shared';

import { getCodexReasoningEfforts, getDefaultModelForCli, getModelsForCli } from '@/common/agent-models';
import { getMessage } from '@/utils/i18n';

export interface SessionSettings {
  model: string;
  permissionMode: string;
  systemPromptConfig: AgentSystemPromptConfig | null;
  optionsConfig?: AgentSessionOptionsConfig;
}

type AgentSessionSettingsPanelProps = {
  open: boolean;
  session: AgentSession | null;
  managementInfo: AgentManagementInfo | null;
  isLoading: boolean;
  isSaving: boolean;
  onClose?: () => void;
  onSave?: (settings: SessionSettings) => void;
};

function getEngineColor(engineName: string): string {
  const colors: Record<string, string> = {
    claude: '#c87941',
    codex: '#10a37f',
    cursor: '#8b5cf6',
    qwen: '#6366f1',
    glm: '#ef4444',
  };
  return colors[engineName] || '#6b7280';
}

export default function AgentSessionSettingsPanel({
  open,
  session,
  managementInfo,
  isLoading,
  isSaving,
  onClose,
  onSave,
}: AgentSessionSettingsPanelProps) {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);

  const [localModel, setLocalModel] = useState('');
  const [localPermissionMode, setLocalPermissionMode] = useState('');
  const [localReasoningEffort, setLocalReasoningEffort] = useState<CodexReasoningEffort>('medium');
  const [localUseCustomPrompt, setLocalUseCustomPrompt] = useState(false);
  const [localCustomPrompt, setLocalCustomPrompt] = useState('');
  const [localAppendToPrompt, setLocalAppendToPrompt] = useState(false);
  const [localPromptAppend, setLocalPromptAppend] = useState('');

  const isClaudeEngine = session?.engineName === 'claude';
  const isCodexEngine = session?.engineName === 'codex';

  const availableModels = useMemo(() => {
    if (!session?.engineName) return [];
    return getModelsForCli(session.engineName);
  }, [session?.engineName]);

  const availableReasoningEfforts = useMemo<readonly CodexReasoningEffort[]>(() => {
    if (!isCodexEngine) return [];
    const effectiveModel = localModel || getDefaultModelForCli('codex');
    return getCodexReasoningEfforts(effectiveModel);
  }, [isCodexEngine, localModel]);

  const normalizedReasoningEffort = useMemo(() => {
    if (availableReasoningEfforts.length === 0) return localReasoningEffort;
    if (availableReasoningEfforts.includes(localReasoningEffort)) return localReasoningEffort;
    return availableReasoningEfforts[availableReasoningEfforts.length - 1];
  }, [availableReasoningEfforts, localReasoningEffort]);

  useEffect(() => {
    if (!session) return;

    setLocalModel(session.model || '');
    setLocalPermissionMode(session.permissionMode || '');

    const codexConfig = session.optionsConfig?.codexConfig;
    if (codexConfig?.reasoningEffort) {
      setLocalReasoningEffort(codexConfig.reasoningEffort);
    } else {
      setLocalReasoningEffort('medium');
    }

    const config = session.systemPromptConfig;
    if (config) {
      if (config.type === 'custom') {
        setLocalUseCustomPrompt(true);
        setLocalCustomPrompt(config.text || '');
        setLocalAppendToPrompt(false);
        setLocalPromptAppend('');
      } else if (config.type === 'preset') {
        setLocalUseCustomPrompt(false);
        setLocalCustomPrompt('');
        setLocalAppendToPrompt(Boolean(config.append));
        setLocalPromptAppend(config.append || '');
      }
    } else {
      setLocalUseCustomPrompt(false);
      setLocalCustomPrompt('');
      setLocalAppendToPrompt(false);
      setLocalPromptAppend('');
    }
  }, [session]);

  useEffect(() => {
    if (!isCodexEngine) return;
    setLocalReasoningEffort(normalizedReasoningEffort);
  }, [isCodexEngine, normalizedReasoningEffort]);

  function handleSave(): void {
    let systemPromptConfig: AgentSystemPromptConfig | null = null;

    if (localUseCustomPrompt && localCustomPrompt.trim()) {
      systemPromptConfig = {
        type: 'custom',
        text: localCustomPrompt.trim(),
      };
    } else if (localAppendToPrompt && localPromptAppend.trim()) {
      systemPromptConfig = {
        type: 'preset',
        preset: 'claude_code',
        append: localPromptAppend.trim(),
      };
    } else {
      systemPromptConfig = {
        type: 'preset',
        preset: 'claude_code',
      };
    }

    let optionsConfig: AgentSessionOptionsConfig | undefined;
    if (isCodexEngine) {
      const existingOptions = session?.optionsConfig ?? {};
      const existingCodexConfig = existingOptions.codexConfig ?? {};
      optionsConfig = {
        ...existingOptions,
        codexConfig: {
          ...existingCodexConfig,
          reasoningEffort: normalizedReasoningEffort,
        },
      };
    }

    onSave?.({
      model: localModel.trim(),
      permissionMode: localPermissionMode,
      systemPromptConfig,
      optionsConfig,
    });
  }

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose?.();
        }
      }}
    >
      <div className="absolute inset-0 bg-black/40" />

      <div
        className="relative w-full max-w-md mx-4 max-h-[85vh] overflow-hidden flex flex-col"
        style={{
          backgroundColor: 'var(--ac-surface, #ffffff)',
          border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
          borderRadius: 'var(--ac-radius-card, 12px)',
          boxShadow: 'var(--ac-shadow-float, 0 4px 20px -2px rgba(0,0,0,0.2))',
        }}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)' }}
        >
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ac-text, #1a1a1a)' }}>
            {t('agentSessionSettingsTitle', 'Session Settings')}
          </h2>
          <button
            className="p-1 ac-btn"
            style={{
              color: 'var(--ac-text-muted, #6e6e6e)',
              borderRadius: 'var(--ac-radius-button)',
            }}
            onClick={onClose}
            type="button"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto ac-scroll px-4 py-3 space-y-4">
          {isLoading ? (
            <div className="py-8 text-center">
              <div className="text-sm" style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                {t('agentSessionSettingsLoading', 'Loading session info...')}
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <label
                  className="text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}
                >
                  {t('agentSessionInfoSection', 'Session Info')}
                </label>
                <div className="text-xs space-y-1" style={{ color: 'var(--ac-text, #1a1a1a)' }}>
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                      {t('agentSessionEngineLabel', 'Engine')}
                    </span>
                    <span
                      className="px-1.5 py-0.5 text-[10px]"
                      style={{
                        backgroundColor: getEngineColor(session?.engineName || ''),
                        color: '#ffffff',
                        borderRadius: 'var(--ac-radius-button, 8px)',
                      }}
                    >
                      {session?.engineName || t('agentUnknownValue', 'Unknown')}
                    </span>
                  </div>
                  {localModel ? (
                    <div className="flex justify-between">
                      <span style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                        {t('agentSessionModelLabel', 'Model')}
                      </span>
                      <span className="font-mono text-[10px]">{localModel}</span>
                    </div>
                  ) : null}
                  {session?.engineSessionId ? (
                    <div className="flex justify-between">
                      <span style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                        {t('agentSessionEngineSessionLabel', 'Engine Session')}
                      </span>
                      <span className="font-mono text-[10px] truncate max-w-[180px]">{session.engineSessionId}</span>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="space-y-2">
                <label
                  className="text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}
                >
                  {t('agentSessionModelLabel', 'Model')}
                </label>
                <select
                  value={localModel}
                  onChange={(event) => setLocalModel(event.currentTarget.value)}
                  className="w-full px-2 py-1.5 text-xs"
                  style={{
                    backgroundColor: 'var(--ac-surface, #ffffff)',
                    border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
                    borderRadius: 'var(--ac-radius-button, 8px)',
                    color: 'var(--ac-text, #1a1a1a)',
                  }}
                >
                  <option value="">
                    {t('agentSessionModelDefaultServer', 'Default (server setting)')}
                  </option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>

              {isCodexEngine ? (
                <div className="space-y-2">
                  <label
                    className="text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}
                  >
                    {t('agentSessionReasoningEffortLabel', 'Reasoning Effort')}
                  </label>
                  <select
                    value={localReasoningEffort}
                    onChange={(event) =>
                      setLocalReasoningEffort(event.currentTarget.value as CodexReasoningEffort)
                    }
                    className="w-full px-2 py-1.5 text-xs"
                    style={{
                      backgroundColor: 'var(--ac-surface, #ffffff)',
                      border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
                      borderRadius: 'var(--ac-radius-button, 8px)',
                      color: 'var(--ac-text, #1a1a1a)',
                    }}
                  >
                    {availableReasoningEfforts.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                  <p className="text-[10px]" style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}>
                    {t(
                      'agentSessionReasoningEffortHint',
                      'Controls the reasoning depth. Higher effort = better quality but slower.',
                    )}
                    {!availableReasoningEfforts.includes('xhigh') ? (
                      <span className="block mt-1">
                        {t(
                          'agentSessionReasoningEffortXhighHint',
                          'Note: xhigh is only available for gpt-5.2 and gpt-5.1-codex-max models.',
                        )}
                      </span>
                    ) : null}
                  </p>
                </div>
              ) : null}

              {isClaudeEngine ? (
                <div className="space-y-2">
                  <label
                    className="text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}
                  >
                    {t('agentSessionPermissionModeLabel', 'Permission Mode')}
                  </label>
                  <select
                    value={localPermissionMode}
                    onChange={(event) => setLocalPermissionMode(event.currentTarget.value)}
                    className="w-full px-2 py-1.5 text-xs"
                    style={{
                      backgroundColor: 'var(--ac-surface, #ffffff)',
                      border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
                      borderRadius: 'var(--ac-radius-button, 8px)',
                      color: 'var(--ac-text, #1a1a1a)',
                    }}
                  >
                    <option value="">{t('agentProjectMenuDefaultOption', 'Default')}</option>
                    <option value="default">
                      {t('agentSessionPermissionDefault', 'default - Ask for approval')}
                    </option>
                    <option value="acceptEdits">
                      {t(
                        'agentSessionPermissionAcceptEdits',
                        'acceptEdits - Auto-accept file edits',
                      )}
                    </option>
                    <option value="bypassPermissions">
                      {t('agentSessionPermissionBypass', 'bypassPermissions - Auto-accept all')}
                    </option>
                    <option value="plan">
                      {t('agentSessionPermissionPlan', 'plan - Plan mode only')}
                    </option>
                    <option value="dontAsk">
                      {t('agentSessionPermissionDontAsk', 'dontAsk - No confirmation')}
                    </option>
                  </select>
                  <p className="text-[10px]" style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}>
                    {t(
                      'agentSessionPermissionHint',
                      'Controls how the Claude SDK handles tool approval requests.',
                    )}
                  </p>
                </div>
              ) : null}

              {isClaudeEngine ? (
                <div className="space-y-2">
                  <label
                    className="text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}
                  >
                    {t('agentSessionSystemPromptLabel', 'System Prompt')}
                  </label>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="radio"
                        checked={!localUseCustomPrompt}
                        onChange={() => setLocalUseCustomPrompt(false)}
                      />
                      <span style={{ color: 'var(--ac-text, #1a1a1a)' }}>
                        {t('agentSessionUsePresetClaudeCode', 'Use preset (claude_code)')}
                      </span>
                    </label>
                    {!localUseCustomPrompt ? (
                      <div className="pl-5">
                        <label className="flex items-center gap-2 text-[10px]">
                          <input
                            type="checkbox"
                            checked={localAppendToPrompt}
                            onChange={(event) => setLocalAppendToPrompt(event.currentTarget.checked)}
                          />
                          <span style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                            {t('agentSessionAppendCustomText', 'Append custom text')}
                          </span>
                        </label>
                        {localAppendToPrompt ? (
                          <textarea
                            value={localPromptAppend}
                            onChange={(event) => setLocalPromptAppend(event.currentTarget.value)}
                            className="mt-1 w-full px-2 py-1.5 text-xs resize-none"
                            style={{
                              backgroundColor: 'var(--ac-surface, #ffffff)',
                              border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
                              borderRadius: 'var(--ac-radius-button, 8px)',
                              color: 'var(--ac-text, #1a1a1a)',
                              fontFamily: 'var(--ac-font-mono, monospace)',
                            }}
                            rows={3}
                            placeholder={t(
                              'agentSessionAppendCustomTextPlaceholder',
                              'Additional instructions to append...',
                            )}
                          />
                        ) : null}
                      </div>
                    ) : null}

                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                      <input
                        type="radio"
                        checked={localUseCustomPrompt}
                        onChange={() => setLocalUseCustomPrompt(true)}
                      />
                      <span style={{ color: 'var(--ac-text, #1a1a1a)' }}>
                        {t('agentSessionUseCustomPrompt', 'Use custom prompt')}
                      </span>
                    </label>
                    {localUseCustomPrompt ? (
                      <textarea
                        value={localCustomPrompt}
                        onChange={(event) => setLocalCustomPrompt(event.currentTarget.value)}
                        className="w-full px-2 py-1.5 text-xs resize-none"
                        style={{
                          backgroundColor: 'var(--ac-surface, #ffffff)',
                          border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
                          borderRadius: 'var(--ac-radius-button, 8px)',
                          color: 'var(--ac-text, #1a1a1a)',
                          fontFamily: 'var(--ac-font-mono, monospace)',
                        }}
                        rows={4}
                        placeholder={t(
                          'agentSessionCustomPromptPlaceholder',
                          'Enter custom system prompt...',
                        )}
                      />
                    ) : null}
                  </div>
                </div>
              ) : null}

              {isClaudeEngine && managementInfo ? (
                <div className="space-y-2">
                  <label
                    className="text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}
                  >
                    {t('agentSessionSdkInfoLabel', 'SDK Info')}
                  </label>
                  <div
                    className="text-[10px] space-y-1 p-2"
                    style={{
                      backgroundColor: 'var(--ac-surface-inset, #f5f5f5)',
                      borderRadius: 'var(--ac-radius-inner, 8px)',
                    }}
                  >
                    {managementInfo.model ? (
                      <div className="flex justify-between">
                        <span style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                          {t('agentSessionActiveModelLabel', 'Active Model')}
                        </span>
                        <span className="font-mono" style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                          {managementInfo.model}
                        </span>
                      </div>
                    ) : null}
                    {managementInfo.claudeCodeVersion ? (
                      <div className="flex justify-between">
                        <span style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                          {t('agentSessionClaudeCodeLabel', 'Claude Code')}
                        </span>
                        <span className="font-mono" style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                          {managementInfo.claudeCodeVersion}
                        </span>
                      </div>
                    ) : null}
                    {managementInfo.tools?.length ? (
                      <div className="flex justify-between">
                        <span style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                          {t('agentSessionToolsLabel', 'Tools')}
                        </span>
                        <span style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                          {managementInfo.tools.length}
                        </span>
                      </div>
                    ) : null}
                    {managementInfo.mcpServers?.length ? (
                      <div className="flex justify-between">
                        <span style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                          {t('agentSessionMcpServersLabel', 'MCP Servers')}
                        </span>
                        <span style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
                          {managementInfo.mcpServers.length}
                        </span>
                      </div>
                    ) : null}
                  </div>

                  {managementInfo.tools?.length ? (
                    <details className="text-[10px]">
                      <summary className="cursor-pointer" style={{ color: 'var(--ac-link, #3b82f6)' }}>
                        {t('agentSessionViewTools', 'View tools ({0})', [
                          String(managementInfo.tools.length),
                        ])}
                      </summary>
                      <div
                        className="mt-1 p-2 max-h-32 overflow-y-auto ac-scroll"
                        style={{
                          backgroundColor: 'var(--ac-surface-inset, #f5f5f5)',
                          borderRadius: 'var(--ac-radius-inner, 8px)',
                        }}
                      >
                        {managementInfo.tools.map((tool) => (
                          <div
                            key={tool}
                            className="font-mono truncate"
                            style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}
                          >
                            {tool}
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}

                  {managementInfo.mcpServers?.length ? (
                    <details className="text-[10px]">
                      <summary className="cursor-pointer" style={{ color: 'var(--ac-link, #3b82f6)' }}>
                        {t('agentSessionViewMcpServers', 'View MCP servers ({0})', [
                          String(managementInfo.mcpServers.length),
                        ])}
                      </summary>
                      <div
                        className="mt-1 p-2 max-h-32 overflow-y-auto ac-scroll"
                        style={{
                          backgroundColor: 'var(--ac-surface-inset, #f5f5f5)',
                          borderRadius: 'var(--ac-radius-inner, 8px)',
                        }}
                      >
                        {managementInfo.mcpServers.map((server) => (
                          <div
                            key={server.name}
                            className="font-mono truncate flex justify-between gap-2"
                            style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}
                          >
                            <span>{server.name}</span>
                            <span
                              className="text-[9px] px-1"
                              style={{
                                backgroundColor: server.status === 'connected' ? '#10b981' : '#6b7280',
                                color: '#fff',
                                borderRadius: 'var(--ac-radius-button, 8px)',
                              }}
                            >
                              {server.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>

        <div
          className="flex items-center justify-end gap-2 px-4 py-3"
          style={{ borderTop: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)' }}
        >
          <button
            className="px-3 py-1.5 text-xs ac-btn"
            style={{
              color: 'var(--ac-text-muted, #6e6e6e)',
              border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
              borderRadius: 'var(--ac-radius-button, 8px)',
            }}
            onClick={onClose}
            type="button"
          >
            {t('cancelButton', 'Cancel')}
          </button>
          <button
            className="px-3 py-1.5 text-xs ac-btn"
            style={{
              backgroundColor: 'var(--ac-accent, #c87941)',
              color: 'var(--ac-accent-contrast, #ffffff)',
              borderRadius: 'var(--ac-radius-button, 8px)',
            }}
            disabled={isSaving}
            onClick={handleSave}
            type="button"
          >
            {isSaving ? t('agentProjectMenuSaving', 'Saving...') : t('saveButton', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}
