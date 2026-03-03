import type { OpenProjectTarget } from 'webpage-mcp-shared';
import { getMessage } from '@/utils/i18n';

type AgentOpenProjectMenuProps = {
  open: boolean;
  defaultTarget: OpenProjectTarget | null;
  onSelect?: (target: OpenProjectTarget) => void;
  onClose?: () => void;
};

export default function AgentOpenProjectMenu({
  open,
  defaultTarget,
  onSelect,
  onClose,
}: AgentOpenProjectMenuProps) {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);

  function handleSelect(target: OpenProjectTarget): void {
    onSelect?.(target);
    onClose?.();
  }

  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed top-12 right-4 z-50 min-w-[160px] py-2"
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
        {t('agentOpenProjectMenuTitle', 'Open In')}
      </div>

      <button
        className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 ac-menu-item"
        style={{
          color: defaultTarget === 'vscode' ? 'var(--ac-accent, #c87941)' : 'var(--ac-text, #1a1a1a)',
        }}
        onClick={() => handleSelect('vscode')}
        type="button"
      >
        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
          <path d="M17.583 2L6.167 11.667 2 8.5v7l4.167-3.167L17.583 22 22 19.75V4.25L17.583 2zm0 3.5v13l-8-6.5 8-6.5z" />
        </svg>
        <span className="flex-1">{t('agentOpenProjectMenuVSCode', 'VS Code')}</span>
        {defaultTarget === 'vscode' ? (
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
          </svg>
        ) : null}
      </button>

      <button
        className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 ac-menu-item"
        style={{
          color:
            defaultTarget === 'terminal' ? 'var(--ac-accent, #c87941)' : 'var(--ac-text, #1a1a1a)',
        }}
        onClick={() => handleSelect('terminal')}
        type="button"
      >
        <svg
          className="w-4 h-4 flex-shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
        <span className="flex-1">{t('agentOpenProjectMenuTerminal', 'Terminal')}</span>
        {defaultTarget === 'terminal' ? (
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
          </svg>
        ) : null}
      </button>
    </div>
  );
}
