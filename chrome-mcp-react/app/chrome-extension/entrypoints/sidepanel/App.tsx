import { useEffect, useMemo, useState } from 'react';

import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import type { ElementMarker, UpsertMarkerRequest } from '@/common/element-marker-types';
import type { AgentThemeId } from './composables/useAgentTheme';
import AgentChat from './components/AgentChat';
import SidepanelNavigator from './components/SidepanelNavigator';
import { WorkflowsView } from './components/workflows';
import { useWorkflowsV3React, type FlowLite } from './react/useWorkflowsV3React';
import './App.css';

type TabType = 'workflows' | 'element-markers' | 'agent-chat';

type MarkerFormState = UpsertMarkerRequest & {
  selectorType: 'css' | 'xpath';
  matchType: 'exact' | 'prefix' | 'host';
};

const THEME_STORAGE_KEY = 'agentTheme';
const DEFAULT_THEME: AgentThemeId = 'warm-editorial';
const VALID_THEMES: AgentThemeId[] = [
  'warm-editorial',
  'blueprint-architect',
  'zen-journal',
  'neo-pop',
  'dark-console',
  'swiss-grid',
];

function isValidTheme(theme: unknown): theme is AgentThemeId {
  return typeof theme === 'string' && VALID_THEMES.includes(theme as AgentThemeId);
}

function getThemeFromDocument(): AgentThemeId {
  const theme = document.documentElement.dataset.agentTheme;
  return isValidTheme(theme) ? theme : DEFAULT_THEME;
}

function getCurrentUrlFromLocation(): string {
  try {
    return window.location.href;
  } catch {
    return '';
  }
}

export default function SidepanelApp() {
  const [currentTheme, setCurrentTheme] = useState<AgentThemeId>(() => getThemeFromDocument());
  const [activeTab, setActiveTab] = useState<TabType>('agent-chat');

  const workflows = useWorkflowsV3React({ autoConnect: true });
  const { flows, runs, triggers } = workflows;

  const [onlyBound, setOnlyBound] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState('');

  const [currentPageUrl, setCurrentPageUrl] = useState('');
  const [markers, setMarkers] = useState<ElementMarker[]>([]);
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null);
  const [markerForm, setMarkerForm] = useState<MarkerFormState>({
    url: '',
    name: '',
    selector: '',
    selectorType: 'css',
    matchType: 'prefix',
  });
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const [markerSearch, setMarkerSearch] = useState('');
  const [markerEditorOpen, setMarkerEditorOpen] = useState(false);

  const filteredMarkers = useMemo(() => {
    const query = markerSearch.trim().toLowerCase();
    if (!query) {
      return markers;
    }

    return markers.filter((marker) => {
      const name = (marker.name || '').toLowerCase();
      const selector = (marker.selector || '').toLowerCase();
      const url = (marker.url || '').toLowerCase();
      return name.includes(query) || selector.includes(query) || url.includes(query);
    });
  }, [markerSearch, markers]);

  const groupedMarkers = useMemo(() => {
    const groups = new Map<string, Map<string, ElementMarker[]>>();

    for (const marker of filteredMarkers) {
      const domain = marker.host || '(本地文件)';
      const fullUrl = marker.url || '(未知URL)';

      if (!groups.has(domain)) {
        groups.set(domain, new Map());
      }

      const domainGroup = groups.get(domain)!;
      if (!domainGroup.has(fullUrl)) {
        domainGroup.set(fullUrl, []);
      }

      domainGroup.get(fullUrl)!.push(marker);
    }

    return Array.from(groups.entries())
      .map(([domain, urlMap]) => ({
        domain,
        count: Array.from(urlMap.values()).reduce((sum, item) => sum + item.length, 0),
        urls: Array.from(urlMap.entries())
          .map(([url, grouped]) => ({ url, markers: grouped }))
          .sort((a, b) => a.url.localeCompare(b.url)),
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain));
  }, [filteredMarkers]);

  const filteredFlows = useMemo(() => {
    if (!onlyBound) {
      return flows;
    }
    return flows.filter(isBoundToCurrentUrl);
  }, [flows, onlyBound, currentUrl]);

  function isBoundToCurrentUrl(flow: FlowLite): boolean {
    try {
      const bindings = flow?.meta?.bindings || [];
      if (!bindings.length) {
        return false;
      }

      if (!currentUrl) {
        return true;
      }

      const parsed = new URL(currentUrl);
      return bindings.some((binding) => {
        const type = binding.kind || binding.type;
        if (type === 'domain') return parsed.hostname.includes(binding.value);
        if (type === 'path') return parsed.pathname.startsWith(binding.value);
        if (type === 'url') return parsed.href.startsWith(binding.value);
        return false;
      });
    } catch {
      return false;
    }
  }

  function handleTabChange(tab: TabType): void {
    setActiveTab(tab);

    const url = new URL(getCurrentUrlFromLocation());
    url.searchParams.set('tab', tab);
    history.replaceState(null, '', url.toString());
  }

  async function handleWorkflowRefresh(): Promise<void> {
    await workflows.refresh();
  }

  async function exportFlow(id: string): Promise<void> {
    try {
      const flowData = await workflows.exportFlow(id);
      if (!flowData) {
        return;
      }

      const blob = new Blob([JSON.stringify(flowData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `workflow-${id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.warn('Export failed:', error);
    }
  }

  function createTrigger() {
    alert('V3 Trigger 管理尚未实现，暂时无法创建触发器');
  }

  function editTrigger(_id: string) {
    alert('V3 Trigger 管理尚未实现，暂时无法编辑触发器');
  }

  async function removeTrigger(id: string): Promise<void> {
    await workflows.deleteTrigger(id);
  }

  function toggleRun(id: string): void {
    setOpenRunId((current) => (current === id ? null : id));
  }

  async function run(id: string): Promise<void> {
    try {
      const result = await workflows.runFlow(id);
      if (!result) {
        console.warn('回放失败');
      }
    } catch {
      // ignore
    }
  }

  function edit(_id: string): void {
    alert('V3 Builder 尚未实现，暂时无法编辑工作流');
  }

  function createFlow(): void {
    alert('V3 Builder 尚未实现，暂时无法创建工作流');
  }

  async function remove(id: string): Promise<void> {
    try {
      const ok = confirm('确认删除该工作流？此操作不可恢复');
      if (!ok) {
        return;
      }
      await workflows.deleteFlow(id);
    } catch {
      // ignore
    }
  }

  function resetForm(nextUrl?: string): void {
    setMarkerForm({
      url: nextUrl ?? currentPageUrl,
      name: '',
      selector: '',
      selectorType: 'css',
      matchType: 'prefix',
    });
    setEditingMarkerId(null);
  }

  function openMarkerEditor(marker?: ElementMarker): void {
    if (marker) {
      setEditingMarkerId(marker.id);
      setMarkerForm({
        url: marker.url,
        name: marker.name,
        selector: marker.selector,
        selectorType: marker.selectorType || 'css',
        listMode: marker.listMode,
        matchType: marker.matchType || 'prefix',
        action: marker.action,
      });
    } else {
      resetForm();
    }
    setMarkerEditorOpen(true);
  }

  function closeMarkerEditor(): void {
    setMarkerEditorOpen(false);
    resetForm();
  }

  async function loadMarkers(): Promise<void> {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      const url = String(tab?.url || '');
      setCurrentPageUrl(url);

      if (!editingMarkerId) {
        setMarkerForm((current) => ({ ...current, url }));
      }

      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_LIST_ALL,
      });

      if (response?.success) {
        setMarkers(response.markers || []);
      }
    } catch (error) {
      console.error('Failed to load markers:', error);
    }
  }

  async function saveMarker(): Promise<void> {
    try {
      if (!markerForm.selector) {
        return;
      }

      const isEditing = Boolean(editingMarkerId);
      let response: any = null;

      if (isEditing) {
        const existingMarker = markers.find((marker) => marker.id === editingMarkerId);

        if (existingMarker && editingMarkerId) {
          const updatedMarker: ElementMarker = {
            ...existingMarker,
            ...markerForm,
            id: editingMarkerId,
          };

          response = await chrome.runtime.sendMessage({
            type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_UPDATE,
            marker: updatedMarker,
          });
        } else {
          response = await chrome.runtime.sendMessage({
            type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_SAVE,
            marker: { ...markerForm, id: editingMarkerId || undefined },
          });
        }
      } else {
        response = await chrome.runtime.sendMessage({
          type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_SAVE,
          marker: { ...markerForm, url: currentPageUrl },
        });
      }

      if (response?.success) {
        closeMarkerEditor();
        await loadMarkers();
      }
    } catch (error) {
      console.error('Failed to save marker:', error);
    }
  }

  async function deleteMarker(marker: ElementMarker): Promise<void> {
    try {
      const confirmed = confirm(`确定要删除标注 "${marker.name}" 吗?`);
      if (!confirmed) {
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_DELETE,
        id: marker.id,
      });

      if (response?.success) {
        await loadMarkers();
      }
    } catch (error) {
      console.error('Failed to delete marker:', error);
    }
  }

  async function validateMarker(marker: ElementMarker): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_VALIDATE,
        selector: marker.selector,
        selectorType: marker.selectorType || 'css',
        action: 'hover',
        listMode: Boolean(marker.listMode),
      });

      if (response?.tool?.ok !== false) {
        await highlightInTab(marker);
      }
    } catch (error) {
      console.error('Failed to validate marker:', error);
    }
  }

  async function isMarkerInjected(tabId: number): Promise<boolean> {
    try {
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, { action: 'element_marker_ping' }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
      ]);
      return (response as any)?.status === 'pong';
    } catch {
      return false;
    }
  }

  async function highlightInTab(marker: ElementMarker): Promise<void> {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) {
        return;
      }

      const alreadyInjected = await isMarkerInjected(tabId);
      if (!alreadyInjected) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ['inject-scripts/element-marker.js'],
            world: 'ISOLATED',
          });
        } catch {
          // ignore
        }
      }

      await chrome.tabs.sendMessage(tabId, {
        action: 'element_marker_highlight',
        selector: marker.selector,
        selectorType: marker.selectorType || 'css',
        listMode: Boolean(marker.listMode),
      });
    } catch (error) {
      console.error('Failed to highlight in tab:', error);
    }
  }

  function toggleDomain(domain: string): void {
    setExpandedDomains((current) => {
      const next = new Set(current);
      if (next.has(domain)) {
        next.delete(domain);
      } else {
        next.add(domain);
      }
      return next;
    });
  }

  useEffect(() => {
    if (!markerSearch.trim()) {
      return;
    }

    const domains = new Set<string>();
    for (const group of groupedMarkers) {
      domains.add(group.domain);
    }
    setExpandedDomains(domains);
  }, [markerSearch, groupedMarkers]);

  useEffect(() => {
    if (activeTab !== 'element-markers') {
      return;
    }

    void loadMarkers();
  }, [activeTab]);

  useEffect(() => {
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local') {
        return;
      }

      const themeChange = changes[THEME_STORAGE_KEY];
      if (themeChange && isValidTheme(themeChange.newValue)) {
        setCurrentTheme(themeChange.newValue);
      }
    };

    chrome.storage.onChanged.addListener(onStorageChanged);

    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        setCurrentUrl(String(tab?.url || ''));
      } catch {
        // ignore
      }

      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get('tab');
      if (tabParam === 'element-markers' || tabParam === 'agent-chat' || tabParam === 'workflows') {
        setActiveTab(tabParam);
        if (tabParam === 'element-markers') {
          await loadMarkers();
        }
      }
    })();

    return () => {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  const workflowsProps = {
    flows: filteredFlows,
    runs,
    triggers,
    onlyBound,
    openRunId,
    onRefresh: () => void handleWorkflowRefresh(),
    onCreate: createFlow,
    onRun: (id: string) => void run(id),
    onEdit: (id: string) => edit(id),
    onDelete: (id: string) => void remove(id),
    onExport: (id: string) => void exportFlow(id),
    onOnlyBoundChange: (value: boolean) => setOnlyBound(value),
    onToggleRun: (id: string) => toggleRun(id),
    onCreateTrigger: createTrigger,
    onEditTrigger: (id: string) => editTrigger(id),
    onRemoveTrigger: (id: string) => void removeTrigger(id),
  };

  return (
    <div className="h-full w-full bg-slate-50 relative agent-theme" data-agent-theme={currentTheme}>
      {activeTab !== 'agent-chat' ? (
        <SidepanelNavigator activeTab={activeTab} onChange={handleTabChange} />
      ) : null}

      {activeTab === 'workflows' ? (
        <div className="h-full">
          <WorkflowsView {...workflowsProps} />
        </div>
      ) : null}

      {activeTab === 'agent-chat' ? (
        <div className="h-full">
          <AgentChat />
        </div>
      ) : null}

      {activeTab === 'element-markers' ? (
        <div className="element-markers-content">
          <div className="px-4 py-4">
            <div className="em-toolbar">
              <div className="em-search-wrapper">
                <svg className="em-search-icon" viewBox="0 0 20 20" width="16" height="16">
                  <path
                    fill="currentColor"
                    d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
                  />
                </svg>
                <input
                  value={markerSearch}
                  onChange={(event) => setMarkerSearch(event.currentTarget.value)}
                  className="em-search-input"
                  placeholder="搜索标注名称、选择器..."
                  type="text"
                />
                {markerSearch ? (
                  <button
                    className="em-search-clear"
                    type="button"
                    onClick={() => setMarkerSearch('')}
                  >
                    <svg viewBox="0 0 20 20" width="14" height="14">
                      <path
                        fill="currentColor"
                        d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
                      />
                    </svg>
                  </button>
                ) : null}
              </div>

              <button className="em-add-btn" onClick={() => openMarkerEditor()} title="新增标注" type="button">
                <svg viewBox="0 0 20 20" width="18" height="18">
                  <path
                    fill="currentColor"
                    d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
                  />
                </svg>
              </button>
            </div>

            {markerEditorOpen ? (
              <div className="em-modal-overlay" onClick={closeMarkerEditor}>
                <div className="em-modal" onClick={(event) => event.stopPropagation()}>
                  <div className="em-modal-header">
                    <h3 className="em-modal-title">{editingMarkerId ? '编辑标注' : '新增标注'}</h3>
                    <button className="em-modal-close" onClick={closeMarkerEditor} type="button">
                      <svg viewBox="0 0 20 20" width="18" height="18">
                        <path
                          fill="currentColor"
                          d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
                        />
                      </svg>
                    </button>
                  </div>

                  <form
                    className="em-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveMarker();
                    }}
                  >
                    <div className="em-form-row">
                      <div className="em-field">
                        <label className="em-field-label">名称</label>
                        <input
                          value={markerForm.name}
                          onChange={(event) =>
                            setMarkerForm((current) => ({ ...current, name: event.currentTarget.value }))
                          }
                          className="em-input"
                          placeholder="例如: 登录按钮"
                          required
                        />
                      </div>
                    </div>

                    <div className="em-form-row em-form-row-multi">
                      <div className="em-field">
                        <label className="em-field-label">选择器类型</label>
                        <div className="em-select-wrapper">
                          <select
                            value={markerForm.selectorType}
                            onChange={(event) =>
                              setMarkerForm((current) => ({
                                ...current,
                                selectorType: event.currentTarget.value as 'css' | 'xpath',
                              }))
                            }
                            className="em-select"
                          >
                            <option value="css">CSS Selector</option>
                            <option value="xpath">XPath</option>
                          </select>
                        </div>
                      </div>

                      <div className="em-field">
                        <label className="em-field-label">匹配类型</label>
                        <div className="em-select-wrapper">
                          <select
                            value={markerForm.matchType}
                            onChange={(event) =>
                              setMarkerForm((current) => ({
                                ...current,
                                matchType: event.currentTarget.value as 'prefix' | 'exact' | 'host',
                              }))
                            }
                            className="em-select"
                          >
                            <option value="prefix">路径前缀</option>
                            <option value="exact">精确匹配</option>
                            <option value="host">域名</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    <div className="em-form-row">
                      <div className="em-field">
                        <label className="em-field-label">选择器</label>
                        <textarea
                          value={markerForm.selector}
                          onChange={(event) =>
                            setMarkerForm((current) => ({ ...current, selector: event.currentTarget.value }))
                          }
                          className="em-textarea"
                          placeholder="CSS 选择器或 XPath"
                          rows={3}
                          required
                        />
                      </div>
                    </div>

                    <div className="em-modal-actions">
                      <button type="button" className="em-btn em-btn-ghost" onClick={closeMarkerEditor}>
                        取消
                      </button>
                      <button type="submit" className="em-btn em-btn-primary">
                        {editingMarkerId ? '更新' : '保存'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            ) : null}

            {filteredMarkers.length > 0 ? (
              <div className="em-list">
                <div className="em-stats-bar">
                  <span className="em-stats-text">
                    {markerSearch ? (
                      <>
                        筛选出 <strong>{filteredMarkers.length}</strong> 个标注 （共 {markers.length} 个，
                        {groupedMarkers.length} 个域名）
                      </>
                    ) : (
                      <>
                        共 <strong>{markers.length}</strong> 个标注，
                        <strong>{groupedMarkers.length}</strong> 个域名
                      </>
                    )}
                  </span>
                </div>

                {groupedMarkers.map((domainGroup) => (
                  <div key={domainGroup.domain} className="em-domain-group">
                    <div className="em-domain-header" onClick={() => toggleDomain(domainGroup.domain)}>
                      <div className="em-domain-info">
                        <svg
                          className={`em-domain-icon ${expandedDomains.has(domainGroup.domain) ? 'em-domain-icon-expanded' : ''}`}
                          viewBox="0 0 20 20"
                          width="16"
                          height="16"
                        >
                          <path fill="currentColor" d="M6 8l4 4 4-4" />
                        </svg>
                        <h3 className="em-domain-name">{domainGroup.domain}</h3>
                        <span className="em-domain-count">{domainGroup.count} 个标注</span>
                      </div>
                    </div>

                    {expandedDomains.has(domainGroup.domain) ? (
                      <div className="em-domain-content">
                        <div className="em-content-wrapper">
                          {domainGroup.urls.map((urlGroup) => (
                            <div key={urlGroup.url} className="em-url-group">
                              <div className="em-url-header">
                                <svg className="em-url-icon" viewBox="0 0 16 16" width="12" height="12">
                                  <path
                                    fill="currentColor"
                                    d="M4 4a1 1 0 011-1h6a1 1 0 011 1v8a1 1 0 01-1 1H5a1 1 0 01-1-1V4zm2 1v1h4V5H6zm0 3v1h4V8H6z"
                                  />
                                </svg>
                                <span className="em-url-path">{urlGroup.url}</span>
                              </div>

                              <div className="em-markers-list">
                                {urlGroup.markers.map((marker) => (
                                  <div key={marker.id} className="em-marker-item">
                                    <div className="em-marker-row-top">
                                      <span className="em-marker-name">{marker.name}</span>
                                      <div className="em-marker-actions">
                                        <button
                                          className="em-action-btn em-action-verify"
                                          onClick={() => void validateMarker(marker)}
                                          title="验证"
                                          type="button"
                                        >
                                          <svg viewBox="0 0 24 24" width="14" height="14">
                                            <path
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                                            />
                                          </svg>
                                        </button>
                                        <button
                                          className="em-action-btn em-action-edit"
                                          onClick={() => openMarkerEditor(marker)}
                                          title="编辑"
                                          type="button"
                                        >
                                          <svg viewBox="0 0 24 24" width="14" height="14">
                                            <path
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                            />
                                          </svg>
                                        </button>
                                        <button
                                          className="em-action-btn em-action-delete"
                                          onClick={() => void deleteMarker(marker)}
                                          title="删除"
                                          type="button"
                                        >
                                          <svg viewBox="0 0 24 24" width="14" height="14">
                                            <path
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                            />
                                          </svg>
                                        </button>
                                      </div>
                                    </div>
                                    <div className="em-marker-row-bottom">
                                      <code className="em-marker-selector" title={marker.selector}>
                                        {marker.selector}
                                      </code>
                                      <div className="em-marker-tags">
                                        <span className="em-tag">{marker.selectorType || 'css'}</span>
                                        <span className="em-tag">{marker.matchType}</span>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="em-empty">
                {markerSearch ? (
                  <span>没有找到匹配的标注</span>
                ) : (
                  <>
                    <span>暂无标注，点击右上角 + 创建第一个标注</span>
                    <button className="em-btn em-btn-primary em-empty-btn" onClick={() => openMarkerEditor()} type="button">
                      创建标注
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
