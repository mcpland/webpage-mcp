import type { ChangeEvent } from 'react';
import type { AgentEngineInfo, AgentProject, CodexReasoningEffort } from 'webpage-mcp-shared';

import { getCodexReasoningEfforts, getDefaultModelForCli, getModelsForCli } from '@/common/agent-models';
import { getMessage } from '@/utils/i18n';

type AgentProjectMenuProps = {
  open: boolean;
  projects: AgentProject[];
  selectedProjectId: string;
  selectedCli: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  enableWebpageMcp: boolean;
  engines: AgentEngineInfo[];
  isPicking: boolean;
  isSaving: boolean;
  error: string | null;
  onProjectSelect?: (projectId: string) => void;
  onProjectNew?: () => void;
  onCliUpdate?: (cli: string) => void;
  onModelUpdate?: (model: string) => void;
  onReasoningEffortUpdate?: (effort: CodexReasoningEffort) => void;
  onWebpageMcpUpdate?: (enableWebpageMcp: boolean) => void;
  onSave?: () => void;
};

export default function AgentProjectMenu({
  open,
  projects,
  selectedProjectId,
  selectedCli,
  model,
  reasoningEffort,
  enableWebpageMcp,
  engines,
  isPicking,
  isSaving,
  error,
  onProjectSelect,
  onProjectNew,
  onCliUpdate,
  onModelUpdate,
  onReasoningEffortUpdate,
  onWebpageMcpUpdate,
  onSave,
}: AgentProjectMenuProps) {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);

  const availableModels = getModelsForCli(selectedCli);

  const trimmedModel = model.trim();
  const normalizedModel =
    !trimmedModel || !selectedCli || availableModels.length === 0
      ? ''
      : availableModels.some((m) => m.id === trimmedModel)
        ? trimmedModel
        : '';

  const isModelDisabled = !selectedCli || availableModels.length === 0;
  const showReasoningEffortOption = selectedCli === 'codex';
  const availableReasoningEfforts: readonly CodexReasoningEffort[] = showReasoningEffortOption
    ? getCodexReasoningEfforts(normalizedModel || getDefaultModelForCli('codex'))
    : [];

  const normalizedReasoningEffort =
    availableReasoningEfforts.length === 0
      ? reasoningEffort
      : availableReasoningEfforts.includes(reasoningEffort)
        ? reasoningEffort
        : availableReasoningEfforts[availableReasoningEfforts.length - 1];

  const showWebpageMcpOption = !selectedCli || selectedCli === 'claude' || selectedCli === 'codex';

  function handleCliChange(event: ChangeEvent<HTMLSelectElement>): void {
    const cli = event.currentTarget.value;
    onCliUpdate?.(cli);

    if (cli) {
      const defaultModel = getDefaultModelForCli(cli);
      const models = getModelsForCli(cli);
      const isValidDefault = models.some((m) => m.id === defaultModel);
      onModelUpdate?.(isValidDefault ? defaultModel : (models[0]?.id ?? ''));
    } else {
      onModelUpdate?.('');
    }
  }

  function handleWebpageMcpChange(event: ChangeEvent<HTMLInputElement>): void {
    onWebpageMcpUpdate?.(event.currentTarget.checked);
  }

  function handleModelChange(event: ChangeEvent<HTMLSelectElement>): void {
    const newModel = event.currentTarget.value;
    onModelUpdate?.(newModel);

    if (selectedCli === 'codex') {
      const supported = getCodexReasoningEfforts(newModel || getDefaultModelForCli('codex'));
      if (!supported.includes(reasoningEffort)) {
        onReasoningEffortUpdate?.(supported[supported.length - 1]);
      }
    }
  }

  function handleReasoningEffortChange(event: ChangeEvent<HTMLSelectElement>): void {
    onReasoningEffortUpdate?.(event.currentTarget.value as CodexReasoningEffort);
  }

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed top-12 left-4 right-4 z-50 py-2 max-w-[calc(100%-2rem)]"
      style={{
        backgroundColor: 'var(--ac-surface, #ffffff)',
        border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
        borderRadius: 'var(--ac-radius-inner, 8px)',
        boxShadow: 'var(--ac-shadow-float, 0 4px 20px -2px rgba(0,0,0,0.1))',
      }}
    >
      <div
        className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider"
        style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}
      >
        {t('agentProjectsTitle', 'Projects')}
      </div>

      <div className="max-h-[200px] overflow-y-auto ac-scroll">
        {projects.map((p) => (
          <button
            key={p.id}
            className="w-full px-3 py-2 text-left text-sm flex items-center justify-between ac-menu-item"
            style={{
              color:
                selectedProjectId === p.id ? 'var(--ac-accent, #c87941)' : 'var(--ac-text, #1a1a1a)',
            }}
            onClick={() => onProjectSelect?.(p.id)}
            type="button"
          >
            <div className="flex-1 min-w-0">
              <div className="truncate">{p.name}</div>
              <div
                className="text-[10px] truncate"
                style={{
                  fontFamily: 'var(--ac-font-mono, monospace)',
                  color: 'var(--ac-text-subtle, #a8a29e)',
                }}
              >
                {p.rootPath}
              </div>
            </div>
            {selectedProjectId === p.id ? (
              <svg className="w-4 h-4 flex-shrink-0 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
              </svg>
            ) : null}
          </button>
        ))}
      </div>

      <button
        className="w-full px-3 py-2 text-left text-sm ac-menu-item"
        style={{ color: 'var(--ac-link, #3b82f6)' }}
        disabled={isPicking}
        onClick={onProjectNew}
        type="button"
      >
        {isPicking
          ? t('agentProjectsSelecting', 'Selecting...')
          : t('agentProjectsNewButton', '+ New Project')}
      </button>

      <div
        className="my-2"
        style={{ borderTop: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)' }}
      />

      <div
        className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider"
        style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}
      >
        {t('agentProjectMenuSettingsTitle', 'Settings')}
      </div>

      <div className="px-3 py-2 flex items-center gap-2">
        <span className="text-xs w-12" style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
          {t('agentProjectMenuCliLabel', 'CLI')}
        </span>
        <select
          value={selectedCli}
          className="flex-1 px-2 py-1 text-xs rounded"
          style={{
            backgroundColor: 'var(--ac-surface-muted, #f2f0eb)',
            border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
            color: 'var(--ac-text, #1a1a1a)',
            borderRadius: 'var(--ac-radius-button, 8px)',
          }}
          onChange={handleCliChange}
        >
          <option value="">{t('agentProjectMenuAutoOption', 'Auto')}</option>
          {engines.map((e) => (
            <option key={e.name} value={e.name}>
              {e.name}
            </option>
          ))}
        </select>
      </div>

      <div className="px-3 py-2 flex items-center gap-2">
        <span className="text-xs w-12" style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
          {t('agentProjectMenuModelLabel', 'Model')}
        </span>
        <select
          value={normalizedModel}
          className="flex-1 px-2 py-1 text-xs rounded"
          style={{
            backgroundColor: 'var(--ac-surface-muted, #f2f0eb)',
            border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
            color: 'var(--ac-text, #1a1a1a)',
            borderRadius: 'var(--ac-radius-button, 8px)',
          }}
          disabled={isModelDisabled}
          onChange={handleModelChange}
        >
          <option value="">{t('agentProjectMenuDefaultOption', 'Default')}</option>
          {availableModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>

      {showReasoningEffortOption ? (
        <div className="px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs w-12" style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
              {t('agentProjectMenuEffortLabel', 'Effort')}
            </span>
            <select
              value={normalizedReasoningEffort}
              className="flex-1 px-2 py-1 text-xs rounded"
              style={{
                backgroundColor: 'var(--ac-surface-muted, #f2f0eb)',
                border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
                color: 'var(--ac-text, #1a1a1a)',
                borderRadius: 'var(--ac-radius-button, 8px)',
              }}
              onChange={handleReasoningEffortChange}
            >
              {availableReasoningEfforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </div>
          <p className="text-[10px] mt-1 ml-14" style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}>
            {t(
              'agentProjectMenuEffortHint',
              'Applies to new sessions. Edit existing session in Session Settings.',
            )}
          </p>
        </div>
      ) : null}

      {showWebpageMcpOption ? (
        <div className="px-3 py-2 flex items-center gap-2">
          <span className="text-xs w-12" style={{ color: 'var(--ac-text-muted, #6e6e6e)' }}>
            {t('agentProjectMenuMcpLabel', 'MCP')}
          </span>
          <label
            className="flex items-center gap-2 cursor-pointer"
            title={t(
              'agentProjectMenuEnableMcpTitle',
              'Enable local Webpage MCP Connector integration',
            )}
          >
            <input
              type="checkbox"
              checked={enableWebpageMcp}
              className="w-4 h-4 rounded"
              style={{
                accentColor: 'var(--ac-accent, #c87941)',
              }}
              onChange={handleWebpageMcpChange}
            />
            <span className="text-xs" style={{ color: 'var(--ac-text, #1a1a1a)' }}>
              {t('agentProjectMenuEnableMcpLabel', 'Enable Webpage MCP Connector')}
            </span>
          </label>
        </div>
      ) : null}

      <div className="px-3 py-2">
        <button
          className="w-full px-3 py-1.5 text-xs rounded transition-colors hover:opacity-90 cursor-pointer"
          style={{
            backgroundColor: 'var(--ac-accent, #c87941)',
            color: 'var(--ac-accent-contrast, #ffffff)',
            borderRadius: 'var(--ac-radius-button, 8px)',
          }}
          disabled={isSaving}
          onClick={onSave}
          type="button"
        >
          {isSaving
            ? t('agentProjectMenuSaving', 'Saving...')
            : t('agentProjectMenuSaveSettings', 'Save Settings')}
        </button>
      </div>

      {error ? (
        <div className="px-3 py-1 text-[10px]" style={{ color: 'var(--ac-danger, #dc2626)' }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
