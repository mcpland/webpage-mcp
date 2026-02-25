import { useCallback, useEffect, useState } from "react";
import type { ElementMarker, UpsertMarkerRequest } from "@/common/element-marker-types";
import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";

export function ElementMarkerManagement() {
  const [currentUrl, setCurrentUrl] = useState("");
  const [markers, setMarkers] = useState<ElementMarker[]>([]);
  const [form, setForm] = useState<UpsertMarkerRequest>({
    url: "",
    name: "",
    selector: "",
    matchType: "prefix",
  });

  const resetForm = useCallback((url?: string) => {
    setForm({
      url: url ?? currentUrl,
      name: "",
      selector: "",
      matchType: "prefix",
    });
  }, [currentUrl]);

  const load = useCallback(async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];
      const url = String(activeTab?.url || "");
      setCurrentUrl(url);

      const response: any = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_LIST_FOR_URL,
        url,
      });

      if (response?.success) {
        setMarkers(response.markers || []);
      } else {
        setMarkers([]);
      }

      setForm((current) => ({ ...current, url }));
    } catch {
      // ignore
    }
  }, []);

  const prefill = useCallback((marker: ElementMarker) => {
    setForm({
      url: marker.url,
      name: marker.name,
      selector: marker.selector,
      selectorType: marker.selectorType,
      listMode: marker.listMode,
      matchType: marker.matchType,
      action: marker.action,
      id: marker.id,
    });
  }, []);

  const save = useCallback(async () => {
    try {
      if (!form.selector) return;

      const nextForm = { ...form, url: currentUrl };
      const response: any = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_SAVE,
        marker: nextForm,
      });

      if (response?.success) {
        resetForm(currentUrl);
        await load();
      }
    } catch {
      // ignore
    }
  }, [currentUrl, form, load, resetForm]);

  const remove = useCallback(async (marker: ElementMarker) => {
    try {
      const response: any = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_DELETE,
        id: marker.id,
      });
      if (response?.success) {
        await load();
      }
    } catch {
      // ignore
    }
  }, [load]);

  const highlightInTab = useCallback(async (marker: ElementMarker) => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) return;

      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ["inject-scripts/element-marker.js"],
          world: "ISOLATED",
        });
      } catch {
        // already injected
      }

      await chrome.tabs.sendMessage(tabId, {
        action: "element_marker_highlight",
        selector: marker.selector,
        selectorType: marker.selectorType || "css",
        listMode: !!marker.listMode,
      });
    } catch {
      // ignore
    }
  }, []);

  const validate = useCallback(async (marker: ElementMarker) => {
    try {
      const response: any = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_VALIDATE,
        selector: marker.selector,
        selectorType: marker.selectorType || "css",
        action: "hover",
        listMode: !!marker.listMode,
      });

      if (response?.tool?.ok !== false) {
        await highlightInTab(marker);
      }
    } catch {
      // ignore
    }
  }, [highlightInTab]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="section">
      <h2 className="section-title">元素标注管理</h2>
      <div className="config-card">
        <div className="status-section" style={{ gap: "8px" }}>
          <div className="status-header">
            <p className="status-label">当前页面</p>
            <span className="status-text" style={{ opacity: 0.85 }}>
              {currentUrl}
            </span>
          </div>
          <div className="status-header">
            <p className="status-label">已标注元素</p>
            <span className="status-text">{markers.length}</span>
          </div>
        </div>

        <form
          className="mcp-config-section"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="mcp-config-header">
            <p className="mcp-config-label">新增标注</p>
          </div>
          <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
            <input
              className="port-input"
              placeholder="名称，如 登录按钮"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.currentTarget.value }))}
            />
            <select
              className="port-input"
              style={{ maxWidth: "120px" }}
              value={form.selectorType || "css"}
              onChange={(event) =>
                setForm((current) => ({ ...current, selectorType: event.currentTarget.value as "css" | "xpath" }))
              }
            >
              <option value="css">CSS</option>
              <option value="xpath">XPath</option>
            </select>
            <select
              className="port-input"
              style={{ maxWidth: "120px" }}
              value={form.matchType || "prefix"}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  matchType: event.currentTarget.value as "exact" | "prefix" | "host",
                }))
              }
            >
              <option value="prefix">路径前缀</option>
              <option value="exact">精确匹配</option>
              <option value="host">域名</option>
            </select>
          </div>
          <input
            className="port-input"
            placeholder="CSS 选择器"
            value={form.selector}
            onChange={(event) => setForm((current) => ({ ...current, selector: event.currentTarget.value }))}
          />
          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            <button className="semantic-engine-button" disabled={!form.selector} type="submit">
              保存
            </button>
            <button className="danger-button" type="button" onClick={() => resetForm()}>
              清空
            </button>
          </div>
        </form>

        {markers.length ? (
          <div className="model-list" style={{ marginTop: "8px" }}>
            {markers.map((marker) => (
              <div
                key={marker.id}
                className="model-card"
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <strong className="model-name">{marker.name}</strong>
                  <code style={{ fontSize: "12px", opacity: 0.85 }}>{marker.selector}</code>
                  <div style={{ display: "flex", gap: "6px", marginTop: "2px" }}>
                    <span className="model-tag dimension">{marker.selectorType || "css"}</span>
                    <span className="model-tag dimension">{marker.matchType}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button className="semantic-engine-button" type="button" onClick={() => void validate(marker)}>
                    验证
                  </button>
                  <button className="secondary-button" type="button" onClick={() => prefill(marker)}>
                    编辑
                  </button>
                  <button className="danger-button" type="button" onClick={() => void remove(marker)}>
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
