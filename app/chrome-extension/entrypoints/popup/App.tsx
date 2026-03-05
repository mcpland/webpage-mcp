import { useEffect, useMemo, useRef, useState } from "react";

import { LINKS } from "@/common/constants";
import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";
import { getMessage } from "@/utils/i18n";
import type { AgentThemeId } from "../sidepanel/composables/useAgentTheme";
import {
  BoltIcon,
  EditIcon,
  MarkerIcon,
  RecordIcon,
  RefreshIcon,
  StopIcon,
  WorkflowIcon,
} from "./react";
import "./App.css";

type NativeConnectionStatus = "unknown" | "connected" | "disconnected";

type ServerStatus = {
  isRunning: boolean;
  lastUpdated: number;
};

type ComingSoonToast = {
  show: boolean;
  feature: string;
};

type RecordingStatus = "idle" | "recording" | "paused" | "stopping";

type RecordingState = {
  status: RecordingStatus;
  sessionId: string | null;
  originTabId: number | null;
  startedAt: string | null;
  durationMs: number;
  stepCount: number;
  activeTabCount: number;
  flowId: string | null;
  flowName: string | null;
};

const THEME_STORAGE_KEY = "agentTheme";
const DEFAULT_THEME: AgentThemeId = "warm-editorial";
const VALID_THEMES: AgentThemeId[] = [
  "warm-editorial",
  "blueprint-architect",
  "zen-journal",
  "neo-pop",
  "dark-console",
  "swiss-grid",
];

const DEFAULT_RECORDING_STATE: RecordingState = {
  status: "idle",
  sessionId: null,
  originTabId: null,
  startedAt: null,
  durationMs: 0,
  stepCount: 0,
  activeTabCount: 0,
  flowId: null,
  flowName: null,
};

function isValidTheme(theme: unknown): theme is AgentThemeId {
  return (
    typeof theme === "string" && VALID_THEMES.includes(theme as AgentThemeId)
  );
}

function getThemeFromDocument(): AgentThemeId {
  const theme = document.documentElement.dataset.agentTheme;
  return isValidTheme(theme) ? theme : DEFAULT_THEME;
}

export default function PopupApp() {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);

  const [agentTheme, setAgentTheme] = useState<AgentThemeId>(() =>
    getThemeFromDocument(),
  );
  const [comingSoonToast, setComingSoonToast] = useState<ComingSoonToast>({
    show: false,
    feature: "",
  });
  const [recordingState, setRecordingState] = useState<RecordingState>(
    DEFAULT_RECORDING_STATE,
  );
  const [recordingAction, setRecordingAction] = useState<"start" | "stop" | null>(
    null,
  );
  const [recordedFlowDraft, setRecordedFlowDraft] = useState<any | null>(null);
  const [recordedFlowName, setRecordedFlowName] = useState("");
  const [recordedFlowDescription, setRecordedFlowDescription] = useState("");
  const [isSavingRecordedFlow, setIsSavingRecordedFlow] = useState(false);

  const [nativeConnectionStatus, setNativeConnectionStatus] =
    useState<NativeConnectionStatus>("unknown");
  const [isConnecting, setIsConnecting] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerStatus>({
    isRunning: false,
    lastUpdated: Date.now(),
  });
  const [copyButtonText, setCopyButtonText] = useState(
    getMessage("copyConfigButton"),
  );
  const [copyRegisterButtonText, setCopyRegisterButtonText] = useState(
    t("popupCopyRegisterCommand", "Copy register command"),
  );
  const [authCopyButtonText, setAuthCopyButtonText] = useState(
    t("popupCopyToken", "Copy token"),
  );
  const [authTokenEnabled, setAuthTokenEnabled] = useState(false);
  const [nativeAuthToken, setNativeAuthToken] = useState<string | null>(null);
  const [nativeConnectionError, setNativeConnectionError] = useState<
    string | null
  >(null);

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authCopyTextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const isConnectedAndRunning =
    nativeConnectionStatus === "connected" && serverStatus.isRunning;
  const showRegisterFallback = nativeConnectionStatus !== "connected";
  const extensionId = chrome.runtime.id;

  const mcpConfigJson = useMemo(() => {
    const config = {
      mcpServers: {
        "webpage-mcp": {
          command: "npx",
          args: ["-y", "-p", "webpage-mcp@latest", "webpage-mcp-stdio"],
        },
      },
    };
    return JSON.stringify(config, null, 2);
  }, []);

  const registerCommand = useMemo(() => {
    return `npx -y webpage-mcp@latest register --browser chrome --force --extension-id ${extensionId}`;
  }, [extensionId]);

  function normalizeRecordingState(payload: unknown): RecordingState {
    if (!payload || typeof payload !== "object") {
      return DEFAULT_RECORDING_STATE;
    }

    const data = payload as Partial<RecordingState>;
    const status: RecordingStatus =
      data.status === "recording" ||
      data.status === "paused" ||
      data.status === "stopping"
        ? data.status
        : "idle";

    return {
      ...DEFAULT_RECORDING_STATE,
      ...data,
      status,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
      originTabId:
        typeof data.originTabId === "number" ? data.originTabId : null,
      startedAt: typeof data.startedAt === "string" ? data.startedAt : null,
      durationMs:
        typeof data.durationMs === "number" && Number.isFinite(data.durationMs)
          ? data.durationMs
          : 0,
      stepCount:
        typeof data.stepCount === "number" && Number.isFinite(data.stepCount)
          ? data.stepCount
          : 0,
      activeTabCount:
        typeof data.activeTabCount === "number" &&
        Number.isFinite(data.activeTabCount)
          ? data.activeTabCount
          : 0,
      flowId: typeof data.flowId === "string" ? data.flowId : null,
      flowName: typeof data.flowName === "string" ? data.flowName : null,
    };
  }

  function suggestRecordedFlowName(flow: any): string {
    const flowName =
      typeof flow?.name === "string" ? flow.name.trim() : "";
    if (flowName && flowName !== "new_workflow") {
      return flowName;
    }

    try {
      const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
      const navigateNode = nodes.find((node: any) => node?.type === "navigate");
      const url = String(navigateNode?.config?.url || "");
      if (url) {
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, "");
        if (host) {
          return `${host} flow`;
        }
      }
    } catch {
      // ignore
    }

    return t("popupRecordedFlowDefaultName", "New recording");
  }

  function showComingSoon(feature: string) {
    setComingSoonToast({ show: true, feature });
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      setComingSoonToast({ show: false, feature: "" });
    }, 2000);
  }

  function getStatusClass(): string {
    if (nativeConnectionStatus === "connected") {
      return serverStatus.isRunning ? "bg-emerald-500" : "bg-yellow-500";
    }
    if (nativeConnectionStatus === "disconnected") {
      return "bg-red-500";
    }
    return "bg-gray-500";
  }

  function getStatusText(): string {
    if (nativeConnectionStatus === "connected") {
      if (serverStatus.isRunning) {
        return getMessage("connectedStatus");
      }
      return getMessage("connectedServiceNotStartedStatus");
    }
    if (nativeConnectionStatus === "disconnected") {
      return getMessage("serviceNotConnectedStatus");
    }
    return getMessage("detectingStatus");
  }

  async function checkNativeConnection() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "ping_native",
      });
      const connected = Boolean(response?.connected);
      setNativeConnectionStatus(connected ? "connected" : "disconnected");
      if (connected) {
        setNativeConnectionError(null);
      }
    } catch (error) {
      console.error("Failed to detect Native connection status:", error);
      setNativeConnectionStatus("disconnected");
    }
  }

  async function checkServerStatus() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS,
      });
      if (response?.success && response.serverStatus) {
        setServerStatus(response.serverStatus as ServerStatus);
      }
      if (response?.connected !== undefined) {
        setNativeConnectionStatus(
          response.connected ? "connected" : "disconnected",
        );
      }
    } catch (error) {
      console.error("Failed to detect server status:", error);
    }
  }

  async function refreshServerStatus() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.REFRESH_SERVER_STATUS,
      });
      if (response?.success && response.serverStatus) {
        setServerStatus(response.serverStatus as ServerStatus);
      }
      if (response?.connected !== undefined) {
        setNativeConnectionStatus(
          response.connected ? "connected" : "disconnected",
        );
      }
    } catch (error) {
      console.error("Failed to refresh server status:", error);
    }
  }

  async function copyMcpConfig() {
    try {
      await navigator.clipboard.writeText(mcpConfigJson);
      setCopyButtonText(`✅${getMessage("configCopiedNotification")}`);
    } catch (error) {
      console.error("Failed to copy configuration:", error);
      setCopyButtonText(`❌${getMessage("networkErrorMessage")}`);
    }

    if (copyTextTimerRef.current) {
      clearTimeout(copyTextTimerRef.current);
    }
    copyTextTimerRef.current = setTimeout(() => {
      setCopyButtonText(getMessage("copyConfigButton"));
    }, 2000);
  }

  async function copyRegisterCommand() {
    try {
      await navigator.clipboard.writeText(registerCommand);
      setCopyRegisterButtonText(t("popupCopiedShort", "Copied"));
    } catch (error) {
      console.error("Failed to copy register command:", error);
      setCopyRegisterButtonText(t("popupCopyFailed", "Copy failed"));
    }

    if (copyTextTimerRef.current) {
      clearTimeout(copyTextTimerRef.current);
    }
    copyTextTimerRef.current = setTimeout(() => {
      setCopyRegisterButtonText(
        t("popupCopyRegisterCommand", "Copy register command"),
      );
    }, 2000);
  }

  async function refreshNativeAuthToken() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.GET_NATIVE_AUTH_TOKEN,
      });
      if (response?.success) {
        setAuthTokenEnabled(response.enabled === true);
        setNativeAuthToken(
          typeof response.token === "string" ? response.token : null,
        );
      } else {
        setAuthTokenEnabled(false);
        setNativeAuthToken(null);
      }
    } catch {
      setAuthTokenEnabled(false);
      setNativeAuthToken(null);
    }
  }

  async function copyAuthToken() {
    if (!nativeAuthToken) return;
    try {
      await navigator.clipboard.writeText(nativeAuthToken);
      setAuthCopyButtonText(t("popupCopiedShort", "Copied"));
    } catch {
      setAuthCopyButtonText(t("popupCopyFailed", "Copy failed"));
    }

    if (authCopyTextTimerRef.current) {
      clearTimeout(authCopyTextTimerRef.current);
    }
    authCopyTextTimerRef.current = setTimeout(() => {
      setAuthCopyButtonText(t("popupCopyToken", "Copy token"));
    }, 2000);
  }

  async function testNativeConnection() {
    if (isConnecting) {
      return;
    }

    setIsConnecting(true);
    try {
      if (nativeConnectionStatus === "connected") {
        await chrome.runtime.sendMessage({ type: "disconnect_native" });
        setNativeConnectionStatus("disconnected");
        setNativeConnectionError(null);
      } else {
        const response = await chrome.runtime.sendMessage({
          type: "connectNative",
        });

        const connected =
          typeof response?.connected === "boolean"
            ? response.connected
            : Boolean(response?.success);
        if (connected) {
          setNativeConnectionStatus("connected");
          setNativeConnectionError(null);
        } else {
          setNativeConnectionStatus("disconnected");
          const reason =
            typeof response?.error === "string" ? response.error : "";
          setNativeConnectionError(reason || "Native host connection failed");
          console.error("Connection failed:", response?.error || response);
        }
      }
    } catch (error) {
      console.error("Test connection failed:", error);
      setNativeConnectionStatus("disconnected");
      setNativeConnectionError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setIsConnecting(false);
    }
  }

  async function openSidepanelAndClose(tab: "workflows" | "element-markers") {
    try {
      const current = await chrome.windows.getCurrent();
      if ((chrome.sidePanel as any)?.setOptions) {
        await (chrome.sidePanel as any).setOptions({
          path: `sidepanel.html?tab=${tab}`,
          enabled: true,
        });
      }
      if ((chrome.sidePanel as any)?.open) {
        await (chrome.sidePanel as any).open({ windowId: current.id! });
      }
      window.close();
    } catch (error) {
      console.warn(`Failed to open sidepanel (${tab}):`, error);
    }
  }

  function openWorkflowSidepanel() {
    showComingSoon(t("popupWorkflowManagementTitle", "Workflow management"));
  }

  function openElementMarkerSidepanel() {
    void openSidepanelAndClose("element-markers");
  }

  async function toggleWebEditor() {
    try {
      await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TOGGLE,
      });
    } catch (error) {
      console.warn("Failed to switch web page editing mode:", error);
    }
  }

  async function toggleElementMarker() {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id) {
        return;
      }

      await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_START,
        tabId: tab.id,
      });
    } catch (error) {
      console.warn("Failed to enable element annotation:", error);
    }
  }

  async function openWelcomePage() {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
    } catch {
      // ignore
    }
  }

  async function openTroubleshooting() {
    try {
      await chrome.tabs.create({ url: LINKS.TROUBLESHOOTING });
    } catch {
      // ignore
    }
  }

  async function refreshRecordingState() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.RR_GET_RECORDING_STATUS,
      });
      if (!response?.success) {
        return;
      }
      setRecordingState(normalizeRecordingState(response.state));
    } catch (error) {
      console.warn("Failed to get recording status:", error);
    }
  }

  async function startRecording() {
    if (recordingAction || recordingState.status !== "idle") {
      return;
    }

    setRecordingAction("start");
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.RR_START_RECORDING,
      });
      if (response?.success) {
        setRecordingState(normalizeRecordingState(response.state));
        if (response?.flow) {
          const nextName = suggestRecordedFlowName(response.flow);
          setRecordedFlowDraft(response.flow);
          setRecordedFlowName(nextName);
          setRecordedFlowDescription(
            typeof response.flow.description === "string"
              ? response.flow.description
              : "",
          );
        }
      }
    } catch (error) {
      console.warn("Failed to start recording:", error);
    } finally {
      setRecordingAction(null);
    }
  }

  async function stopRecording() {
    if (recordingAction || recordingState.status === "idle") {
      return;
    }

    setRecordingAction("stop");
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.RR_STOP_RECORDING,
      });
      if (response?.success) {
        setRecordingState(normalizeRecordingState(response.state));
        setRecordedFlowDraft(null);
      }
      if (response?.error) {
        console.warn("Stop recording warning:", response.error);
      }
    } catch (error) {
      console.warn("Failed to stop recording:", error);
    } finally {
      setRecordingAction(null);
    }
  }

  async function saveRecordedFlowDraft() {
    if (!recordedFlowDraft || isSavingRecordedFlow) {
      return;
    }

    const nextName = recordedFlowName.trim() || suggestRecordedFlowName(recordedFlowDraft);
    const nextDescription = recordedFlowDescription.trim();
    const updatedFlow = {
      ...recordedFlowDraft,
      name: nextName,
      description: nextDescription || undefined,
      meta: {
        ...(recordedFlowDraft.meta || {}),
        updatedAt: new Date().toISOString(),
      },
    };

    setIsSavingRecordedFlow(true);
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.RR_SAVE_FLOW,
        flow: updatedFlow,
      });
      if (response?.success) {
        setRecordedFlowDraft(null);
      }
    } catch (error) {
      console.warn("Failed to save recorded flow:", error);
    } finally {
      setIsSavingRecordedFlow(false);
    }
  }

  function dismissRecordedFlowDraft() {
    setRecordedFlowDraft(null);
  }

  useEffect(() => {
    const onRuntimeMessage = (message: {
      type?: string;
      payload?: unknown;
    }) => {
      if (
        message.type === BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED &&
        message.payload
      ) {
        setServerStatus(message.payload as ServerStatus);
        return;
      }
      if (
        message.type === BACKGROUND_MESSAGE_TYPES.RR_RECORDING_STATE_CHANGED &&
        message.payload
      ) {
        setRecordingState(normalizeRecordingState(message.payload));
      }
    };

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local") {
        return;
      }

      const themeChange = changes[THEME_STORAGE_KEY];
      if (themeChange && isValidTheme(themeChange.newValue)) {
        setAgentTheme(themeChange.newValue);
        document.documentElement.dataset.agentTheme = themeChange.newValue;
      }
    };

    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);

    void (async () => {
      await checkNativeConnection();
      await checkServerStatus();
      await refreshRecordingState();
    })();

    return () => {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);

      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
      if (copyTextTimerRef.current) {
        clearTimeout(copyTextTimerRef.current);
      }
      if (authCopyTextTimerRef.current) {
        clearTimeout(authCopyTextTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isConnectedAndRunning) {
      void refreshNativeAuthToken();
      return;
    }
    setAuthTokenEnabled(false);
    setNativeAuthToken(null);
  }, [isConnectedAndRunning]);

  function getHeaderStatusClass(): string {
    if (recordingState.status === "recording") {
      return "status-recording";
    }
    if (recordingState.status === "paused") {
      return "status-warning";
    }
    if (recordingState.status === "stopping") {
      return "status-warning";
    }
    if (nativeConnectionStatus === "connected") {
      return serverStatus.isRunning ? "status-running" : "status-warning";
    }
    if (nativeConnectionStatus === "disconnected") {
      return "status-error";
    }
    return "status-unknown";
  }

  function getHeaderStatusText(): string {
    if (recordingState.status === "recording") {
      return t("popupRecordingBadge", "Recording");
    }
    if (recordingState.status === "paused") {
      return t("popupRecordingPaused", "Recording paused");
    }
    if (recordingState.status === "stopping") {
      return t("popupRecordingStopping", "Stopping...");
    }
    if (nativeConnectionStatus === "connected") {
      if (serverStatus.isRunning) {
        return t("popupStatusRunning", "Running");
      }
      return t("popupStatusIdle", "Idle");
    }
    if (nativeConnectionStatus === "disconnected") {
      return t("popupStatusOffline", "Offline");
    }
    return t("popupStatusDetecting", "Detecting");
  }

  const canStartRecording =
    recordingState.status === "idle" && recordingAction === null;
  const canStopRecording =
    (recordingState.status === "recording" ||
      recordingState.status === "paused" ||
      recordingState.status === "stopping") &&
    recordingAction === null;

  return (
    <div className="popup-container agent-theme" data-agent-theme={agentTheme}>
      <div className="home-view">
        {/* Header with brand + status badge */}
        <div className="header">
          <div className="header-top">
            <div className="header-brand">
              <div className="header-logo">
                <BoltIcon className="icon-small" />
              </div>
              <h1 className="header-title">
                {t("extensionName", "Webpage MCP Connector")}
              </h1>
            </div>
            <div className={`header-status ${getHeaderStatusClass()}`}>
              <span className="status-dot" />
              <span>{getHeaderStatusText()}</span>
            </div>
          </div>
        </div>

        <div className="content">
          {/* Server Config Section */}
          <div className="section">
            <div className="section-header">
              <h2 className="section-title">{getMessage("nativeServerConfigLabel")}</h2>
              <button
                className="refresh-status-button"
                type="button"
                onClick={() => void refreshServerStatus()}
                title={getMessage("refreshStatusButton")}
              >
                <RefreshIcon className="icon-small" />
              </button>
            </div>
            <div className="config-card">
              <div className="status-section">
                <div className="status-info">
                  <span className={`status-dot ${getStatusClass()}`} />
                  <span className="status-text">{getStatusText()}</span>
                </div>
                {serverStatus.lastUpdated ? (
                  <div className="status-timestamp">
                    {getMessage("lastUpdatedLabel")}{" "}
                    {new Date(serverStatus.lastUpdated).toLocaleTimeString()}
                  </div>
                ) : null}
              </div>

              <div className="mcp-config-section">
                <div className="mcp-config-header">
                  <p className="mcp-config-label">{getMessage("mcpServerConfigLabel")}</p>
                  <button
                    className="copy-config-button"
                    type="button"
                    onClick={() => void copyMcpConfig()}
                  >
                    {copyButtonText}
                  </button>
                </div>
                <div className="mcp-config-content">
                  <pre className="mcp-config-json">{mcpConfigJson}</pre>
                </div>
              </div>

              {isConnectedAndRunning && authTokenEnabled && nativeAuthToken ? (
                <div className="mcp-config-section">
                  <div className="mcp-config-header">
                    <p className="mcp-config-label">{t("popupAuthTokenLabel", "Auth token")}</p>
                    <button
                      className="copy-config-button"
                      type="button"
                      onClick={() => void copyAuthToken()}
                    >
                      {authCopyButtonText}
                    </button>
                  </div>
                  <div className="mcp-config-content">
                    <pre className="mcp-config-json">{nativeAuthToken}</pre>
                  </div>
                </div>
              ) : null}

              {showRegisterFallback ? (
                <details className="register-fallback-section">
                  <summary className="register-fallback-summary">
                    {t(
                      "popupManualRegistrationLabel",
                      "Manual registration (if auto-registration fails)",
                    )}
                  </summary>
                  <div className="register-fallback-content">
                    <p className="register-fallback-hint">
                      {t(
                        "popupManualRegistrationHint",
                        "Only needed if auto-registration did not work. Requires Node.js.",
                      )}
                    </p>
                    <div className="mcp-config-header">
                      <p className="mcp-config-label">
                        {t(
                          "popupOneTimeHostRegistrationLabel",
                          "One-time host registration (current extension ID)",
                        )}
                      </p>
                      <button
                        className="copy-config-button"
                        type="button"
                        onClick={() => void copyRegisterCommand()}
                      >
                        {copyRegisterButtonText}
                      </button>
                    </div>
                    <div className="mcp-config-content">
                      <pre className="mcp-config-json">{registerCommand}</pre>
                    </div>
                    {nativeConnectionError ? (
                      <p className="register-command-error">
                        {t("popupConnectFailedPrefix", "Connect failed")}: {nativeConnectionError}
                      </p>
                    ) : null}
                  </div>
                </details>
              ) : null}

              <button
                className="connect-button"
                type="button"
                disabled={isConnecting}
                onClick={() => void testNativeConnection()}
              >
                <BoltIcon />
                <span>
                  {isConnecting
                    ? getMessage("connectingStatus")
                    : nativeConnectionStatus === "connected"
                      ? getMessage("disconnectButton")
                      : getMessage("connectButton")}
                </span>
              </button>
            </div>
          </div>

          {/* Quick Tools - labeled icon grid */}
          <div className="section">
            <div className="section-header">
              <h2 className="section-title">{t("popupQuickToolsTitle", "Quick tools")}</h2>
            </div>
            <div className="quick-tools-grid">
              <button
                className={`quick-tool-item has-tooltip${!canStartRecording ? " quick-tool-disabled" : ""}`}
                type="button"
                disabled={!canStartRecording}
                onClick={() => void startRecording()}
                data-tooltip={
                  canStartRecording
                    ? t("popupToolRecordHint", "Start recording browser actions")
                    : t(
                        "popupToolRecordDisabledHint",
                        "Recording is already in progress",
                      )
                }
              >
                <div className="quick-tool-icon icon-record">
                  <RecordIcon recording={recordingState.status === "recording"} />
                </div>
                <span className="quick-tool-label">
                  {t("popupToolRecord", "Record")}
                </span>
              </button>
              <button
                className={`quick-tool-item has-tooltip${!canStopRecording ? " quick-tool-disabled" : ""}`}
                type="button"
                disabled={!canStopRecording}
                onClick={() => void stopRecording()}
                data-tooltip={
                  canStopRecording
                    ? t("popupToolStopHint", "Stop recording and save flow")
                    : t("popupToolStopDisabledHint", "No active recording")
                }
              >
                <div className="quick-tool-icon icon-stop">
                  <StopIcon />
                </div>
                <span className="quick-tool-label">
                  {t("popupToolStop", "Stop")}
                </span>
              </button>
              <button
                className="quick-tool-item has-tooltip"
                type="button"
                onClick={() => void toggleWebEditor()}
                data-tooltip={t(
                  "popupEnableWebEditorTooltip",
                  "Turn on page editing mode",
                )}
              >
                <div className="quick-tool-icon icon-edit">
                  <EditIcon />
                </div>
                <span className="quick-tool-label">
                  {t("popupToolEditor", "Editor")}
                </span>
              </button>
              <button
                className="quick-tool-item has-tooltip"
                type="button"
                onClick={() => void toggleElementMarker()}
                data-tooltip={t(
                  "popupEnableElementMarkerTooltip",
                  "Turn on element annotation",
                )}
              >
                <div className="quick-tool-icon icon-marker">
                  <MarkerIcon />
                </div>
                <span className="quick-tool-label">
                  {t("popupToolMarker", "Marker")}
                </span>
              </button>
            </div>

            {recordedFlowDraft ? (
              <div className="recorded-flow-card">
                <div className="recorded-flow-header">
                  <h3 className="recorded-flow-title">
                    {t("popupSaveRecordingTitle", "Save recording")}
                  </h3>
                  <span className="recorded-flow-id">
                    {String(recordedFlowDraft.id || "")}
                  </span>
                </div>
                <div className="recorded-flow-fields">
                  <label className="recorded-flow-label">
                    {t("popupFlowNameLabel", "Flow name")}
                  </label>
                  <input
                    className="recorded-flow-input"
                    value={recordedFlowName}
                    onChange={(event) => setRecordedFlowName(event.currentTarget.value)}
                    placeholder={t("popupFlowNamePlaceholder", "Enter a flow name")}
                    type="text"
                  />
                  <label className="recorded-flow-label">
                    {t("popupFlowDescriptionLabel", "Description")}
                  </label>
                  <textarea
                    className="recorded-flow-input recorded-flow-textarea"
                    value={recordedFlowDescription}
                    onChange={(event) =>
                      setRecordedFlowDescription(event.currentTarget.value)
                    }
                    placeholder={t(
                      "popupFlowDescriptionPlaceholder",
                      "Describe this flow (optional)",
                    )}
                  />
                </div>
                <div className="recorded-flow-actions">
                  <button
                    className="recorded-flow-btn"
                    type="button"
                    onClick={dismissRecordedFlowDraft}
                    disabled={isSavingRecordedFlow}
                  >
                    {t("popupDismissButton", "Dismiss")}
                  </button>
                  <button
                    className="recorded-flow-btn recorded-flow-btn-primary"
                    type="button"
                    onClick={() => void saveRecordedFlowDraft()}
                    disabled={isSavingRecordedFlow}
                  >
                    {isSavingRecordedFlow
                      ? t("popupSavingButton", "Saving...")
                      : t("popupSaveButton", "Save")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* Management Portal */}
          <div className="section">
            <div className="section-header">
              <h2 className="section-title">
                {t("popupManagementPortalTitle", "Management portal")}
              </h2>
            </div>
            <div className="entry-card">
              <button
                className="entry-item entry-item-coming-soon"
                type="button"
                onClick={openWorkflowSidepanel}
              >
                <div className="entry-icon workflow">
                  <WorkflowIcon />
                </div>
                <div className="entry-content">
                  <span className="entry-title">
                    {t("popupWorkflowManagementTitle", "Workflow management")}
                    <span className="coming-soon-badge">
                      {t("popupComingSoonBadge", "Coming Soon")}
                    </span>
                  </span>
                  <span className="entry-desc">
                    {t(
                      "popupWorkflowManagementDesc",
                      "Recording and playback automation workflows",
                    )}
                  </span>
                </div>
                <svg
                  className="entry-arrow"
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </button>

              <button
                className="entry-item"
                type="button"
                onClick={openElementMarkerSidepanel}
              >
                <div className="entry-icon marker">
                  <MarkerIcon />
                </div>
                <div className="entry-content">
                  <span className="entry-title">
                    {t(
                      "popupElementMarkerManagementTitle",
                      "Element annotation management",
                    )}
                  </span>
                  <span className="entry-desc">
                    {t(
                      "popupElementMarkerManagementDesc",
                      "Manage page element annotations",
                    )}
                  </span>
                </div>
                <svg
                  className="entry-arrow"
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 5l7 7-7 7"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="footer">
          <div className="footer-links">
            <button
              className="footer-link"
              type="button"
              onClick={() => void openWelcomePage()}
              title={t("popupViewInstallGuideTitle", "View installation guide")}
            >
              <svg
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              {t("popupGuideLink", "Guide")}
            </button>
            <button
              className="footer-link"
              type="button"
              onClick={() => void openTroubleshooting()}
              title={t("popupTroubleshootingTitle", "Troubleshooting")}
            >
              <svg
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                />
              </svg>
              {t("popupDocsLink", "Docs")}
            </button>
          </div>
          <p className="footer-text">
            {t("popupFooterTagline", "webpage mcp connector for ai")}
          </p>
        </div>
      </div>

      {comingSoonToast.show ? (
        <div className="coming-soon-toast">
          <span>🚧</span>
          <span>
            {`${comingSoonToast.feature} ${t(
              "popupFeatureUnderDevelopmentSuffix",
              "The feature is under development, please stay tuned",
            )}`}
          </span>
        </div>
      ) : null}
    </div>
  );
}
