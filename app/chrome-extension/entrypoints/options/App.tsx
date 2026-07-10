import { useCallback, useEffect, useState } from "react";
import { TOOL_NAMES } from "webpage-mcp-shared";
import { STORAGE_KEYS } from "@/common/constants";
import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";

import "./App.css";

type ListItem = {
  id: string;
  name?: string;
  status: "enabled" | "disabled";
  world: "ISOLATED" | "MAIN";
  runAt: "document_start" | "document_end" | "document_idle";
  updatedAt: number;
};

type FormState = {
  name: string;
  runAt: string;
  world: string;
  mode: string;
  allFrames: boolean;
  persist: boolean;
  dnrFallback: boolean;
  script: string;
  matches: string;
  excludes: string;
  tags: string;
};

const DEFAULT_FORM: FormState = {
  name: "",
  runAt: "auto",
  world: "auto",
  mode: "auto",
  allFrames: true,
  persist: true,
  dnrFallback: true,
  script: "",
  matches: "",
  excludes: "",
  tags: "",
};

type FiltersState = {
  query: string;
  status: string;
  domain: string;
};

type StorageStats = {
  indexedPages: number;
  totalDocuments: number;
  totalTabs: number;
  indexSize: number;
};

type StorageStatus = {
  kind: "info" | "success" | "error";
  message: string;
};

const DEFAULT_FILTERS: FiltersState = {
  query: "",
  status: "",
  domain: "",
};

function formatTime(ts?: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** unitIndex;
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function m(key: string, substitutions?: string | string[]): string {
  const msg = (
    globalThis.chrome?.i18n?.getMessage(key, substitutions as any) || ""
  ).trim();
  return msg || key;
}

export default function OptionsApp() {
  const [emergencyDisabled, setEmergencyDisabled] = useState(false);
  const [items, setItems] = useState<ListItem[]>([]);
  const [filters, setFilters] = useState<FiltersState>(DEFAULT_FILTERS);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState("");
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(
    null,
  );

  const callTool = useCallback(async (name: string, args: unknown) => {
    const res = await globalThis.chrome?.runtime?.sendMessage({
      type: "call_tool",
      name,
      args,
    } as any);
    if (!res || !res.success) throw new Error(res?.error || "call failed");
    return res.result;
  }, []);

  const saveEmergency = useCallback(
    async (nextValue: boolean) => {
      setEmergencyDisabled(nextValue);
      await globalThis.chrome?.storage?.local.set({
        [STORAGE_KEYS.USERSCRIPTS_DISABLED]: nextValue,
      });
    },
    [setEmergencyDisabled],
  );

  const loadEmergency = useCallback(async () => {
    const v = await globalThis.chrome?.storage?.local.get([
      STORAGE_KEYS.USERSCRIPTS_DISABLED,
    ] as any);
    setEmergencyDisabled(!!v?.[STORAGE_KEYS.USERSCRIPTS_DISABLED]);
  }, []);

  const reload = useCallback(async () => {
    const result = await callTool(TOOL_NAMES.BROWSER.USERSCRIPT, {
      action: "list",
      args: { ...filters },
    });

    try {
      const txt = (result?.content?.[0]?.text as string) || "{}";
      const data = JSON.parse(txt);
      setItems(data.items || []);
    } catch (e) {
      console.warn("parse list failed", e);
    }
  }, [callTool, filters]);

  const apply = useCallback(
    async (mode: "auto" | "once") => {
      if (!form.script.trim()) return;
      setSubmitting(true);
      setLastResult("");

      try {
        const args: Record<string, any> = {
          script: form.script,
          name: form.name || undefined,
          runAt: form.runAt,
          world: form.world,
          allFrames: !!form.allFrames,
          persist: !!form.persist,
          dnrFallback: !!form.dnrFallback,
          mode,
        };

        if (form.matches.trim()) {
          args.matches = form.matches
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }

        if (form.excludes.trim()) {
          args.excludes = form.excludes
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }

        if (form.tags.trim()) {
          args.tags = form.tags
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }

        const result = await callTool(TOOL_NAMES.BROWSER.USERSCRIPT, {
          action: "create",
          args,
        });
        setLastResult((result?.content?.[0]?.text as string) || "");
        await reload();
      } catch (e: any) {
        setLastResult(`Error: ${e?.message || String(e)}`);
      } finally {
        setSubmitting(false);
      }
    },
    [callTool, form, reload],
  );

  const toggle = useCallback(
    async (item: ListItem) => {
      try {
        await callTool(TOOL_NAMES.BROWSER.USERSCRIPT, {
          action: item.status === "enabled" ? "disable" : "enable",
          args: { id: item.id },
        });
        await reload();
      } catch (e) {
        console.warn("toggle failed", e);
      }
    },
    [callTool, reload],
  );

  const remove = useCallback(
    async (item: ListItem) => {
      try {
        await callTool(TOOL_NAMES.BROWSER.USERSCRIPT, {
          action: "remove",
          args: { id: item.id },
        });
        await reload();
      } catch (e) {
        console.warn("remove failed", e);
      }
    },
    [callTool, reload],
  );

  const exportAll = useCallback(async () => {
    try {
      const res = await callTool(TOOL_NAMES.BROWSER.USERSCRIPT, {
        action: "export",
        args: {},
      });
      const txt = (res?.content?.[0]?.text as string) || "{}";
      const blob = new Blob([txt], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      await globalThis.chrome?.downloads?.download({
        url,
        filename: "userscripts-export.json",
        saveAs: true,
      } as any);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn("export failed", e);
    }
  }, [callTool]);

  const loadStorageStats = useCallback(async (showProgress = false) => {
    if (showProgress)
      setStorageStatus({ kind: "info", message: m("semanticDataLoading") });

    try {
      const response = await globalThis.chrome?.runtime?.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.GET_STORAGE_STATS,
      });
      if (!response?.success)
        throw new Error(response?.error || "request failed");
      if (response.stats?.available !== true) {
        setStorageStats(null);
        if (showProgress) setStorageStatus(null);
        return;
      }

      setStorageStats({
        indexedPages: safeCount(response.stats?.indexedPages),
        totalDocuments: safeCount(response.stats?.totalDocuments),
        totalTabs: safeCount(response.stats?.totalTabs),
        indexSize: safeCount(response.stats?.indexSize),
      });
      if (showProgress) setStorageStatus(null);
    } catch (error) {
      setStorageStats(null);
      const detail = error instanceof Error ? error.message : String(error);
      setStorageStatus({
        kind: "error",
        message: `${m("semanticDataStatsFailure")}: ${detail}`,
      });
    }
  }, []);

  const clearSemanticData = useCallback(async () => {
    if (!globalThis.confirm(m("semanticDataConfirm"))) return;

    setStorageBusy(true);
    setStorageStatus({ kind: "info", message: m("semanticDataClearing") });
    try {
      const response = await globalThis.chrome?.runtime?.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA,
      });
      if (!response?.success)
        throw new Error(response?.error || "request failed");

      await loadStorageStats();
      setStorageStatus({
        kind: "success",
        message: m("semanticDataClearSuccess"),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setStorageStatus({
        kind: "error",
        message: `${m("semanticDataClearFailure")}: ${detail}`,
      });
    } finally {
      setStorageBusy(false);
    }
  }, [loadStorageStats]);

  useEffect(() => {
    void loadEmergency();
  }, [loadEmergency]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void loadStorageStats();
  }, [loadStorageStats]);

  return (
    <div className="page">
      <header className="topbar">
        <h1>{m("settingsTitle")}</h1>
      </header>

      <section
        className="storage-management"
        aria-labelledby="semantic-data-title"
      >
        <h2 id="semantic-data-title">{m("semanticDataSectionTitle")}</h2>
        <p id="semantic-data-description" className="hint">
          {m("semanticDataDescription")}
        </p>
        <dl className="storage-stats" aria-label={m("semanticDataStatsLabel")}>
          <div>
            <dt>{m("semanticDataIndexedPagesLabel")}</dt>
            <dd>
              {storageStats?.indexedPages ?? m("semanticDataUnavailable")}
            </dd>
          </div>
          <div>
            <dt>{m("semanticDataDocumentsLabel")}</dt>
            <dd>
              {storageStats?.totalDocuments ?? m("semanticDataUnavailable")}
            </dd>
          </div>
          <div>
            <dt>{m("semanticDataTabsLabel")}</dt>
            <dd>{storageStats?.totalTabs ?? m("semanticDataUnavailable")}</dd>
          </div>
          <div>
            <dt>{m("semanticDataIndexSizeLabel")}</dt>
            <dd>
              {storageStats
                ? formatBytes(storageStats.indexSize)
                : m("semanticDataUnavailable")}
            </dd>
          </div>
        </dl>
        <div className="row storage-actions">
          <button
            type="button"
            disabled={storageBusy}
            aria-describedby="semantic-data-description"
            onClick={() => void loadStorageStats(true)}
          >
            {m("semanticDataRefreshButton")}
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={storageBusy}
            aria-describedby="semantic-data-description"
            onClick={() => void clearSemanticData()}
          >
            {m("semanticDataClearButton")}
          </button>
        </div>
        {storageStatus ? (
          <p
            id="storage-management-status"
            className={`storage-status storage-status-${storageStatus.kind}`}
            role={storageStatus.kind === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {storageStatus.message}
          </p>
        ) : null}
      </section>

      <section
        className="userscript-controls"
        aria-labelledby="userscripts-title"
      >
        <h2 id="userscripts-title">{m("userscriptsManagerTitle")}</h2>
        <div className="switch">
          <label>
            <input
              type="checkbox"
              checked={emergencyDisabled}
              onChange={(event) =>
                void saveEmergency(event.currentTarget.checked)
              }
            />
            <span>{m("emergencySwitchLabel")}</span>
          </label>
        </div>
      </section>

      <section className="create">
        <h2>{m("createRunSectionTitle")}</h2>
        <div className="grid">
          <label>
            {m("nameLabel")}
            <input
              value={form.name}
              placeholder={m("placeholderOptional")}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  name: event.currentTarget.value,
                }))
              }
            />
          </label>
          <label>
            {m("runAtLabel")}
            <select
              value={form.runAt}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  runAt: event.currentTarget.value,
                }))
              }
            >
              <option value="auto">{m("runAtAuto")}</option>
              <option value="document_start">{m("runAtDocumentStart")}</option>
              <option value="document_end">{m("runAtDocumentEnd")}</option>
              <option value="document_idle">{m("runAtDocumentIdle")}</option>
            </select>
          </label>
          <label>
            {m("worldLabel")}
            <select
              value={form.world}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  world: event.currentTarget.value,
                }))
              }
            >
              <option value="auto">{m("worldAuto")}</option>
              <option value="ISOLATED">{m("worldIsolated")}</option>
              <option value="MAIN">{m("worldMain")}</option>
            </select>
          </label>
          <label>
            {m("modeLabel")}
            <select
              value={form.mode}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  mode: event.currentTarget.value,
                }))
              }
            >
              <option value="auto">{m("modeAuto")}</option>
              <option value="persistent">{m("modePersistent")}</option>
              <option value="css">{m("modeCss")}</option>
              <option value="once">{m("modeOnce")}</option>
            </select>
          </label>
          <label>
            {m("allFramesLabel")}
            <input
              type="checkbox"
              checked={form.allFrames}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  allFrames: event.currentTarget.checked,
                }))
              }
            />
          </label>
          <label>
            {m("persistLabel")}
            <input
              type="checkbox"
              checked={form.persist}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  persist: event.currentTarget.checked,
                }))
              }
            />
          </label>
          <label>
            {m("dnrFallbackLabel")}
            <input
              type="checkbox"
              checked={form.dnrFallback}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  dnrFallback: event.currentTarget.checked,
                }))
              }
            />
          </label>
        </div>
        <label>
          {m("matchesInputLabel")}
          <input
            value={form.matches}
            placeholder={m("placeholderMatchesExample")}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                matches: event.currentTarget.value,
              }))
            }
          />
        </label>
        <label>
          {m("excludesInputLabel")}
          <input
            value={form.excludes}
            placeholder={m("placeholderOptional")}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                excludes: event.currentTarget.value,
              }))
            }
          />
        </label>
        <label>
          {m("tagsInputLabel")}
          <input
            value={form.tags}
            placeholder={m("placeholderOptional")}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                tags: event.currentTarget.value,
              }))
            }
          />
        </label>
        <label>
          {m("scriptLabel")}
          <textarea
            value={form.script}
            placeholder={m("placeholderScriptHint")}
            rows={8}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                script: event.currentTarget.value,
              }))
            }
          />
        </label>
        <div className="row">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void apply("auto")}
          >
            {m("applyButton")}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void apply("once")}
          >
            {m("runOnceButton")}
          </button>
          {lastResult ? <span className="hint">{lastResult}</span> : null}
        </div>
      </section>

      <section className="filters">
        <h2>{m("listSectionTitle")}</h2>
        <div className="grid">
          <label>
            {m("queryLabel")}
            <input
              value={filters.query}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  query: event.currentTarget.value,
                }))
              }
            />
          </label>
          <label>
            {m("statusLabel")}
            <select
              value={filters.status}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  status: event.currentTarget.value,
                }))
              }
            >
              <option value="">{m("statusAll")}</option>
              <option value="enabled">{m("statusEnabled")}</option>
              <option value="disabled">{m("statusDisabled")}</option>
            </select>
          </label>
          <label>
            {m("domainLabel")}
            <input
              value={filters.domain}
              placeholder={m("placeholderDomainHint")}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  domain: event.currentTarget.value,
                }))
              }
            />
          </label>
        </div>
        <div className="row">
          <button type="button" onClick={() => void exportAll()}>
            {m("exportAllButton")}
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{m("tableHeaderName")}</th>
              <th>{m("statusLabel")}</th>
              <th>{m("tableHeaderWorld")}</th>
              <th>{m("tableHeaderRunAt")}</th>
              <th>{m("tableHeaderUpdated")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.name || item.id}</td>
                <td>
                  <label>
                    <input
                      type="checkbox"
                      checked={item.status === "enabled"}
                      onChange={() => void toggle(item)}
                    />
                    {item.status}
                  </label>
                </td>
                <td>{item.world}</td>
                <td>{item.runAt}</td>
                <td>{formatTime(item.updatedAt)}</td>
                <td className="actions">
                  <button type="button" onClick={() => void remove(item)}>
                    {m("deleteButton")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
