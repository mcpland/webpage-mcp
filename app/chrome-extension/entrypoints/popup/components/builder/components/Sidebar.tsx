import { useMemo, useState } from 'react';

import type { Flow as FlowV2, NodeBase } from '@/entrypoints/background/record-replay/types';
import { NODE_UI_LIST } from '@/entrypoints/popup/components/builder/model/ui-nodes';
import { getMessage } from '@/utils/i18n';
import './Sidebar.css';

type SidebarItem = {
  type: NodeBase['type'];
  label: string;
  category: 'Flow' | 'Actions' | 'Tools' | 'Tabs' | 'Logic' | 'Page';
  iconClass: string;
};

type SidebarProps = {
  flow: FlowV2;
  paletteTypes: NodeBase['type'][];
  subflowIds?: string[];
  currentSubflowId?: string | null;
  onAddNode: (t: NodeBase['type']) => void;
  onSwitchMain: () => void;
  onSwitchSubflow: (id: string) => void;
  onAddSubflow: (id: string) => void;
  onRemoveSubflow: (id: string) => void;
};

function SidebarGroup({
  items,
  onAddNode,
  onDragStart,
}: {
  items: SidebarItem[];
  onAddNode: (t: NodeBase['type']) => void;
  onDragStart: (t: NodeBase['type'], e: React.DragEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="builder-sidebar__nodes-section">
      {items.map((item) => (
        <button
          key={item.type}
          className="builder-sidebar__node-btn"
          draggable
          onDragStart={(event) => onDragStart(item.type, event)}
          onClick={() => onAddNode(item.type)}
          title={item.label}
          type="button"
        >
          <div className={`builder-sidebar__btn-icon ${item.iconClass}`}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M4 8h8M8 4v8"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <span className="builder-sidebar__btn-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

export default function Sidebar({ paletteTypes, onAddNode }: SidebarProps) {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const allow = new Set((paletteTypes || []) as string[]);
    const items = NODE_UI_LIST.filter((n) => allow.size === 0 || allow.has(n.type));
    const term = query.trim().toLowerCase();

    const list = term
      ? items.filter(
          (n) => n.label.toLowerCase().includes(term) || n.type.toLowerCase().includes(term),
        )
      : items;

    return {
      Flow: list.filter((x) => x.category === 'Flow'),
      Actions: list.filter((x) => x.category === 'Actions'),
      Tools: list.filter((x) => x.category === 'Tools'),
      Tabs: list.filter((x) => x.category === 'Tabs'),
      Logic: list.filter((x) => x.category === 'Logic'),
      Page: list.filter((x) => x.category === 'Page'),
    };
  }, [paletteTypes, query]);

  function onDragStart(type: NodeBase['type'], event: React.DragEvent<HTMLButtonElement>) {
    try {
      const dt = event.dataTransfer;
      if (!dt) return;
      dt.setData('application/node-type', String(type));
      dt.setData('text/node-type', String(type));
      dt.setData('text/plain', String(type));
      dt.effectAllowed = 'copy';
    } catch {
      // ignore
    }
  }

  return (
    <aside className="builder-sidebar">
      <div className="builder-sidebar__search-box">
        <svg className="builder-sidebar__search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.5" />
          <path d="m10 10 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          className="builder-sidebar__search-input"
          placeholder={t('builderInsertNodePlaceholder', 'Insert node...')}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      {filtered.Flow.length > 0 ? (
        <>
          <div className="builder-sidebar__section-divider">
            <span className="builder-sidebar__divider-label">
              {t('builderFlowCategory', 'Flow')}
            </span>
          </div>
          <SidebarGroup items={filtered.Flow as SidebarItem[]} onAddNode={onAddNode} onDragStart={onDragStart} />
        </>
      ) : null}

      <SidebarGroup items={filtered.Actions as SidebarItem[]} onAddNode={onAddNode} onDragStart={onDragStart} />

      <div className="builder-sidebar__section-divider">
        <span className="builder-sidebar__divider-label">{t('builderToolsCategory', 'Tools')}</span>
      </div>
      <SidebarGroup items={filtered.Tools as SidebarItem[]} onAddNode={onAddNode} onDragStart={onDragStart} />

      <div className="builder-sidebar__section-divider">
        <span className="builder-sidebar__divider-label">{t('builderTabsCategory', 'Tabs')}</span>
      </div>
      <SidebarGroup items={filtered.Tabs as SidebarItem[]} onAddNode={onAddNode} onDragStart={onDragStart} />

      <div className="builder-sidebar__section-divider">
        <span className="builder-sidebar__divider-label">{t('builderLogicCategory', 'Logic')}</span>
      </div>
      <SidebarGroup items={filtered.Logic as SidebarItem[]} onAddNode={onAddNode} onDragStart={onDragStart} />
    </aside>
  );
}
