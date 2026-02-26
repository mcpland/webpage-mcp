import { THEME_LABELS, type AgentThemeId } from '../../composables';

type AgentSettingsMenuProps = {
  open: boolean;
  theme: AgentThemeId;
  fakeCaretEnabled?: boolean;
  onThemeSet?: (theme: AgentThemeId) => void;
  onReconnect?: () => void;
  onAttachmentsOpen?: () => void;
  onFakeCaretToggle?: (enabled: boolean) => void;
};

const themes: Array<{ id: AgentThemeId; label: string }> = [
  { id: 'warm-editorial', label: THEME_LABELS['warm-editorial'] },
  { id: 'blueprint-architect', label: THEME_LABELS['blueprint-architect'] },
  { id: 'zen-journal', label: THEME_LABELS['zen-journal'] },
  { id: 'neo-pop', label: THEME_LABELS['neo-pop'] },
  { id: 'dark-console', label: THEME_LABELS['dark-console'] },
  { id: 'swiss-grid', label: THEME_LABELS['swiss-grid'] },
];

export default function AgentSettingsMenu({
  open,
  theme,
  fakeCaretEnabled,
  onThemeSet,
  onReconnect,
  onAttachmentsOpen,
  onFakeCaretToggle,
}: AgentSettingsMenuProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed top-12 right-4 z-50 min-w-[180px] py-2"
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
        Theme
      </div>

      {themes.map((themeItem) => (
        <button
          key={themeItem.id}
          className="w-full px-3 py-2 text-left text-sm flex items-center justify-between ac-menu-item"
          style={{
            color: theme === themeItem.id ? 'var(--ac-accent, #c87941)' : 'var(--ac-text, #1a1a1a)',
          }}
          onClick={() => onThemeSet?.(themeItem.id)}
          type="button"
        >
          <span>{themeItem.label}</span>
          {theme === themeItem.id ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
            </svg>
          ) : null}
        </button>
      ))}

      <div
        className="my-2"
        style={{
          borderTop: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
        }}
      />

      <div
        className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider"
        style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}
      >
        Input
      </div>

      <button
        className="w-full px-3 py-2 text-left text-sm flex items-center justify-between ac-menu-item"
        style={{ color: 'var(--ac-text, #1a1a1a)' }}
        onClick={() => onFakeCaretToggle?.(!fakeCaretEnabled)}
        type="button"
      >
        <span>Comet caret</span>
        {fakeCaretEnabled ? (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
          </svg>
        ) : null}
      </button>

      <div
        className="my-2"
        style={{
          borderTop: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
        }}
      />

      <div
        className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider"
        style={{ color: 'var(--ac-text-subtle, #a8a29e)' }}
      >
        Storage
      </div>

      <button
        className="w-full px-3 py-2 text-left text-sm ac-menu-item"
        style={{ color: 'var(--ac-text, #1a1a1a)' }}
        onClick={onAttachmentsOpen}
        type="button"
      >
        Clear Attachment Cache
      </button>

      <div
        className="my-2"
        style={{
          borderTop: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
        }}
      />

      <button
        className="w-full px-3 py-2 text-left text-sm ac-menu-item"
        style={{ color: 'var(--ac-text, #1a1a1a)' }}
        onClick={onReconnect}
        type="button"
      >
        Reconnect Server
      </button>
    </div>
  );
}
