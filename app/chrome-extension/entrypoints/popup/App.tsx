import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';

import { LINKS } from '@/common/constants';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import {
  PREDEFINED_MODELS,
  clearModelCache,
  cleanupModelCache,
  getCacheStats,
  getModelInfo,
  type ModelPreset,
} from '@/utils/semantic-similarity-engine';
import { getMessage } from '@/utils/i18n';
import type { AgentThemeId } from '../sidepanel/composables/useAgentTheme';
import {
  BoltIcon,
  ConfirmDialog,
  EditIcon,
  LocalModelPage,
  MarkerIcon,
  RecordIcon,
  RefreshIcon,
  StopIcon,
  WorkflowIcon,
} from './react';
import './App.css';

type CurrentView = 'home' | 'local-model';
type NativeConnectionStatus = 'unknown' | 'connected' | 'disconnected';
type SemanticEngineStatus = 'idle' | 'initializing' | 'ready' | 'error';
type ModelInitializationStatus = 'idle' | 'downloading' | 'initializing' | 'ready' | 'error';

type ServerStatus = {
  isRunning: boolean;
  port?: number;
  lastUpdated: number;
};

type StorageStats = {
  indexedPages: number;
  totalDocuments: number;
  totalTabs: number;
  indexSize: number;
  isInitialized: boolean;
};

type CacheStats = {
  totalSize: number;
  totalSizeMB: number;
  entryCount: number;
  entries: Array<{
    url: string;
    size: number;
    sizeMB: number;
    timestamp: number;
    age: string;
    expired: boolean;
  }>;
};

type ComingSoonToast = {
  show: boolean;
  feature: string;
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

function getErrorTypeByMessage(errorMessage: string): '' | 'network' | 'file' | 'unknown' {
  const text = errorMessage.toLowerCase();
  if (text.includes('network') || text.includes('fetch') || text.includes('timeout')) {
    return 'network';
  }
  if (text.includes('corrupt') || text.includes('invalid') || text.includes('format')) {
    return 'file';
  }
  return 'unknown';
}

export default function PopupApp() {
  const [agentTheme, setAgentTheme] = useState<AgentThemeId>(() => getThemeFromDocument());
  const [currentView, setCurrentView] = useState<CurrentView>('home');
  const [comingSoonToast, setComingSoonToast] = useState<ComingSoonToast>({ show: false, feature: '' });

  const [nativeConnectionStatus, setNativeConnectionStatus] = useState<NativeConnectionStatus>('unknown');
  const [isConnecting, setIsConnecting] = useState(false);
  const [nativeServerPort, setNativeServerPort] = useState(12306);
  const [serverStatus, setServerStatus] = useState<ServerStatus>({
    isRunning: false,
    lastUpdated: Date.now(),
  });
  const [copyButtonText, setCopyButtonText] = useState(getMessage('copyConfigButton'));

  const [currentModel, setCurrentModel] = useState<ModelPreset | null>(null);
  const [isModelSwitching, setIsModelSwitching] = useState(false);
  const [modelSwitchProgress, setModelSwitchProgress] = useState('');
  const [modelDownloadProgress, setModelDownloadProgress] = useState(0);
  const [isModelDownloading, setIsModelDownloading] = useState(false);
  const [modelInitializationStatus, setModelInitializationStatus] =
    useState<ModelInitializationStatus>('idle');
  const [modelErrorMessage, setModelErrorMessage] = useState('');
  const [modelErrorType, setModelErrorType] = useState<'' | 'network' | 'file' | 'unknown'>('');

  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [isRefreshingStats, setIsRefreshingStats] = useState(false);
  const [isClearingData, setIsClearingData] = useState(false);
  const [showClearConfirmation, setShowClearConfirmation] = useState(false);
  const [clearDataProgress, setClearDataProgress] = useState('');

  const [semanticEngineStatus, setSemanticEngineStatus] = useState<SemanticEngineStatus>('idle');
  const [isSemanticEngineInitializing, setIsSemanticEngineInitializing] = useState(false);
  const [semanticEngineInitProgress, setSemanticEngineInitProgress] = useState('');
  const [semanticEngineLastUpdated, setSemanticEngineLastUpdated] = useState<number | null>(null);

  const [isManagingCache, setIsManagingCache] = useState(false);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusMonitoringIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const semanticEnginePollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const showMcpConfig = nativeConnectionStatus === 'connected' && serverStatus.isRunning;

  const mcpConfigJson = useMemo(() => {
    const port = serverStatus.port || nativeServerPort;
    const config = {
      mcpServers: {
        'streamable-mcp-server': {
          type: 'streamable-http',
          url: `http://127.0.0.1:${port}/mcp`,
        },
      },
    };
    return JSON.stringify(config, null, 2);
  }, [nativeServerPort, serverStatus.port]);

  const availableModels = useMemo(() => {
    return Object.entries(PREDEFINED_MODELS).map(([preset, model]) => ({
      preset,
      ...model,
    }));
  }, []);

  function showComingSoon(feature: string) {
    setComingSoonToast({ show: true, feature });
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      setComingSoonToast({ show: false, feature: '' });
    }, 2000);
  }

  function getStatusClass(): string {
    if (nativeConnectionStatus === 'connected') {
      return serverStatus.isRunning ? 'bg-emerald-500' : 'bg-yellow-500';
    }
    if (nativeConnectionStatus === 'disconnected') {
      return 'bg-red-500';
    }
    return 'bg-gray-500';
  }

  function getStatusText(): string {
    if (nativeConnectionStatus === 'connected') {
      if (serverStatus.isRunning) {
        return getMessage('serviceRunningStatus', [(serverStatus.port || 'Unknown').toString()]);
      }
      return getMessage('connectedServiceNotStartedStatus');
    }
    if (nativeConnectionStatus === 'disconnected') {
      return getMessage('serviceNotConnectedStatus');
    }
    return getMessage('detectingStatus');
  }

  async function savePortPreference(port: number) {
    try {
      await chrome.storage.local.set({ nativeServerPort: port });
    } catch (error) {
      console.error('Failed to save port preference:', error);
    }
  }

  async function loadPortPreference() {
    try {
      const result = await chrome.storage.local.get(['nativeServerPort']);
      const saved = result.nativeServerPort;
      if (typeof saved === 'number' && Number.isFinite(saved)) {
        setNativeServerPort(saved);
      }
    } catch (error) {
      console.error('Failed to load port preferences:', error);
    }
  }

  async function saveModelPreference(model: ModelPreset) {
    try {
      await chrome.storage.local.set({ selectedModel: model });
    } catch (error) {
      console.error('Failed to save model preferences:', error);
    }
  }

  async function saveVersionPreference(version: 'full' | 'quantized' | 'compressed') {
    try {
      await chrome.storage.local.set({ selectedVersion: version });
    } catch (error) {
      console.error('Failed to save version preferences:', error);
    }
  }

  async function saveModelState(
    status: ModelInitializationStatus,
    downloadProgress: number,
    downloading: boolean,
  ) {
    try {
      const modelState = {
        status,
        downloadProgress,
        isDownloading: downloading,
        lastUpdated: Date.now(),
      };
      await chrome.storage.local.set({ modelState });
    } catch (error) {
      console.error('Failed to save model state:', error);
    }
  }

  async function saveSemanticEngineState(status: SemanticEngineStatus, lastUpdated: number | null) {
    try {
      await chrome.storage.local.set({
        semanticEngineState: {
          status,
          lastUpdated,
        },
      });
    } catch (error) {
      console.error('Failed to save semantic engine state:', error);
    }
  }

  async function checkNativeConnection() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ping_native' });
      setNativeConnectionStatus(response?.connected ? 'connected' : 'disconnected');
    } catch (error) {
      console.error('Failed to detect Native connection status:', error);
      setNativeConnectionStatus('disconnected');
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
        setNativeConnectionStatus(response.connected ? 'connected' : 'disconnected');
      }
    } catch (error) {
      console.error('Failed to detect server status:', error);
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
        setNativeConnectionStatus(response.connected ? 'connected' : 'disconnected');
      }
    } catch (error) {
      console.error('Failed to refresh server status:', error);
    }
  }

  async function copyMcpConfig() {
    try {
      await navigator.clipboard.writeText(mcpConfigJson);
      setCopyButtonText(`✅${getMessage('configCopiedNotification')}`);
    } catch (error) {
      console.error('Failed to copy configuration:', error);
      setCopyButtonText(`❌${getMessage('networkErrorMessage')}`);
    }

    if (copyTextTimerRef.current) {
      clearTimeout(copyTextTimerRef.current);
    }
    copyTextTimerRef.current = setTimeout(() => {
      setCopyButtonText(getMessage('copyConfigButton'));
    }, 2000);
  }

  async function updatePort(event: ChangeEvent<HTMLInputElement>) {
    const value = Number(event.currentTarget.value);
    setNativeServerPort(value);
    if (Number.isFinite(value)) {
      await savePortPreference(value);
    }
  }

  async function testNativeConnection() {
    if (isConnecting) {
      return;
    }

    setIsConnecting(true);
    try {
      if (nativeConnectionStatus === 'connected') {
        await chrome.runtime.sendMessage({ type: 'disconnect_native' });
        setNativeConnectionStatus('disconnected');
      } else {
        const response = await chrome.runtime.sendMessage({
          type: 'connectNative',
          port: nativeServerPort,
        });

        if (response?.success) {
          setNativeConnectionStatus('connected');
          await savePortPreference(nativeServerPort);
        } else {
          setNativeConnectionStatus('disconnected');
          console.error('Connection failed:', response);
        }
      }
    } catch (error) {
      console.error('Test connection failed:', error);
      setNativeConnectionStatus('disconnected');
    } finally {
      setIsConnecting(false);
    }
  }

  async function loadCacheStats() {
    try {
      const stats = await getCacheStats();
      setCacheStats(stats as CacheStats);
    } catch (error) {
      console.error('Failed to get cache stats:', error);
      setCacheStats(null);
    }
  }

  async function cleanupCache() {
    if (isManagingCache) {
      return;
    }

    setIsManagingCache(true);
    try {
      await cleanupModelCache();
      await loadCacheStats();
    } catch (error) {
      console.error('Failed to cleanup cache:', error);
    } finally {
      setIsManagingCache(false);
    }
  }

  async function clearAllCache() {
    if (isManagingCache) {
      return;
    }

    setIsManagingCache(true);
    try {
      await clearModelCache();
      await loadCacheStats();
    } catch (error) {
      console.error('Failed to clear cache:', error);
    } finally {
      setIsManagingCache(false);
    }
  }

  async function refreshStorageStats() {
    if (isRefreshingStats) {
      return;
    }

    setIsRefreshingStats(true);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'get_storage_stats',
      });

      if (response?.success) {
        setStorageStats({
          indexedPages: response.stats.indexedPages || 0,
          totalDocuments: response.stats.totalDocuments || 0,
          totalTabs: response.stats.totalTabs || 0,
          indexSize: response.stats.indexSize || 0,
          isInitialized: response.stats.isInitialized || false,
        });
      } else {
        setStorageStats({
          indexedPages: 0,
          totalDocuments: 0,
          totalTabs: 0,
          indexSize: 0,
          isInitialized: false,
        });
      }
    } catch (error) {
      console.error('❌ Error refreshing storage stats:', error);
      setStorageStats({
        indexedPages: 0,
        totalDocuments: 0,
        totalTabs: 0,
        indexSize: 0,
        isInitialized: false,
      });
    } finally {
      setIsRefreshingStats(false);
    }
  }

  function stopModelStatusMonitoring() {
    if (statusMonitoringIntervalRef.current) {
      clearInterval(statusMonitoringIntervalRef.current);
      statusMonitoringIntervalRef.current = null;
    }
  }

  function startModelStatusMonitoring() {
    stopModelStatusMonitoring();

    statusMonitoringIntervalRef.current = setInterval(async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'get_model_status',
        });

        if (!response?.success) {
          return;
        }

        const status = response.status;
        const nextStatus = (status.initializationStatus || 'idle') as ModelInitializationStatus;
        const nextProgress = status.downloadProgress || 0;
        const nextDownloading = status.isDownloading || false;

        setModelInitializationStatus(nextStatus);
        setModelDownloadProgress(nextProgress);
        setIsModelDownloading(nextDownloading);

        if (nextStatus === 'error') {
          const nextErrorMessage = status.errorMessage || getMessage('modelFailedStatus');
          setModelErrorMessage(nextErrorMessage);
          setModelErrorType(getErrorTypeByMessage(nextErrorMessage));
        } else {
          setModelErrorMessage('');
          setModelErrorType('');
        }

        await saveModelState(nextStatus, nextProgress, nextDownloading);

        if (nextStatus === 'ready' || nextStatus === 'error') {
          stopModelStatusMonitoring();
        }
      } catch (error) {
        console.error('Failed to get model status:', error);
      }
    }, 1000);
  }

  function stopSemanticEngineStatusPolling() {
    if (semanticEnginePollingIntervalRef.current) {
      clearInterval(semanticEnginePollingIntervalRef.current);
      semanticEnginePollingIntervalRef.current = null;
    }
  }

  async function checkSemanticEngineStatus() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS,
      });

      if (!(response?.success && response.status)) {
        setSemanticEngineStatus('idle');
        setIsSemanticEngineInitializing(false);
        await saveSemanticEngineState('idle', semanticEngineLastUpdated);
        return;
      }

      const status = response.status.initializationStatus;
      if (status === 'ready') {
        const lastUpdated = Date.now();
        setSemanticEngineStatus('ready');
        setSemanticEngineLastUpdated(lastUpdated);
        setIsSemanticEngineInitializing(false);
        setSemanticEngineInitProgress(getMessage('semanticEngineReadyStatus'));
        await saveSemanticEngineState('ready', lastUpdated);
        stopSemanticEngineStatusPolling();
        setTimeout(() => {
          setSemanticEngineInitProgress('');
        }, 2000);
        return;
      }

      if (status === 'downloading' || status === 'initializing') {
        const lastUpdated = Date.now();
        setSemanticEngineStatus('initializing');
        setIsSemanticEngineInitializing(true);
        setSemanticEngineInitProgress(getMessage('semanticEngineInitializingStatus'));
        setSemanticEngineLastUpdated(lastUpdated);
        await saveSemanticEngineState('initializing', lastUpdated);
        return;
      }

      if (status === 'error') {
        const lastUpdated = Date.now();
        setSemanticEngineStatus('error');
        setSemanticEngineLastUpdated(lastUpdated);
        setIsSemanticEngineInitializing(false);
        setSemanticEngineInitProgress(getMessage('semanticEngineInitFailedStatus'));
        await saveSemanticEngineState('error', lastUpdated);
        stopSemanticEngineStatusPolling();
        setTimeout(() => {
          setSemanticEngineInitProgress('');
        }, 5000);
        return;
      }

      setSemanticEngineStatus('idle');
      setIsSemanticEngineInitializing(false);
      await saveSemanticEngineState('idle', semanticEngineLastUpdated);
    } catch (error) {
      console.error('Popup: Failed to check semantic engine status:', error);
      setSemanticEngineStatus('idle');
      setIsSemanticEngineInitializing(false);
      await saveSemanticEngineState('idle', semanticEngineLastUpdated);
    }
  }

  function startSemanticEngineStatusPolling() {
    stopSemanticEngineStatusPolling();

    semanticEnginePollingIntervalRef.current = setInterval(() => {
      void checkSemanticEngineStatus();
    }, 2000);
  }

  async function initializeSemanticEngine() {
    if (isSemanticEngineInitializing) {
      return;
    }

    const lastUpdated = Date.now();
    setIsSemanticEngineInitializing(true);
    setSemanticEngineStatus('initializing');
    setSemanticEngineInitProgress(getMessage('semanticEngineInitializingStatus'));
    setSemanticEngineLastUpdated(lastUpdated);
    await saveSemanticEngineState('initializing', lastUpdated);

    try {
      await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.INITIALIZE_SEMANTIC_ENGINE,
      });

      startSemanticEngineStatusPolling();
      setSemanticEngineInitProgress(getMessage('processingStatus'));
    } catch (error: any) {
      console.error('❌ Failed to send initialization request:', error);
      const now = Date.now();
      setSemanticEngineStatus('error');
      setSemanticEngineInitProgress(
        `Failed to send initialization request: ${error?.message || 'Unknown error'}`,
      );
      setSemanticEngineLastUpdated(now);
      setIsSemanticEngineInitializing(false);
      await saveSemanticEngineState('error', now);

      setTimeout(() => {
        setSemanticEngineInitProgress('');
      }, 5000);
    }
  }

  async function switchModel(newModel: ModelPreset, force = false) {
    if (isModelSwitching) {
      return;
    }

    const currentInfo = currentModel
      ? getModelInfo(currentModel)
      : getModelInfo('multilingual-e5-small');
    const newInfo = getModelInfo(newModel);
    const isSameModel = newModel === currentModel;
    const isDifferentDimension = currentInfo.dimension !== newInfo.dimension;

    if (!force && isSameModel && !isDifferentDimension) {
      return;
    }

    setIsModelSwitching(true);
    setModelSwitchProgress(getMessage('switchingModelStatus'));
    setModelInitializationStatus('downloading');
    setModelDownloadProgress(0);
    setIsModelDownloading(true);

    try {
      await saveModelPreference(newModel);
      await saveVersionPreference('quantized');
      await saveModelState('downloading', 0, true);

      setModelSwitchProgress(getMessage('semanticEngineInitializingStatus'));
      startModelStatusMonitoring();

      const response = await chrome.runtime.sendMessage({
        type: 'switch_semantic_model',
        modelPreset: newModel,
        modelVersion: 'quantized',
        modelDimension: newInfo.dimension,
        previousDimension: currentInfo.dimension,
      });

      if (!response?.success) {
        throw new Error(response?.error || 'Model switch failed');
      }

      setCurrentModel(newModel);
      setModelSwitchProgress(getMessage('successNotification'));
      setModelInitializationStatus('ready');
      setIsModelDownloading(false);
      await saveModelState('ready', 100, false);

      setTimeout(() => {
        setModelSwitchProgress('');
      }, 2000);
    } catch (error: any) {
      const errorMessage = error?.message || 'Unknown error';
      setModelSwitchProgress(`Model switch failed: ${errorMessage}`);
      setModelInitializationStatus('error');
      setIsModelDownloading(false);

      const nextErrorType = getErrorTypeByMessage(errorMessage);
      setModelErrorType(nextErrorType);
      if (nextErrorType === 'network') {
        setModelErrorMessage(getMessage('networkErrorMessage'));
      } else if (nextErrorType === 'file') {
        setModelErrorMessage(getMessage('modelCorruptedErrorMessage'));
      } else {
        setModelErrorMessage(errorMessage);
      }

      await saveModelState('error', modelDownloadProgress, false);

      setTimeout(() => {
        setModelSwitchProgress('');
      }, 8000);
    } finally {
      setIsModelSwitching(false);
    }
  }

  async function retryModelInitialization() {
    if (!currentModel) {
      return;
    }

    setModelErrorMessage('');
    setModelErrorType('');
    setModelInitializationStatus('downloading');
    setModelDownloadProgress(0);
    setIsModelDownloading(true);
    await switchModel(currentModel, true);
  }

  async function loadModelPreference() {
    try {
      const result = await chrome.storage.local.get([
        'selectedModel',
        'selectedVersion',
        'modelState',
        'semanticEngineState',
      ]);

      const storedModel = result.selectedModel as string | undefined;
      if (storedModel && PREDEFINED_MODELS[storedModel as ModelPreset]) {
        setCurrentModel(storedModel as ModelPreset);
      } else {
        const defaultModel: ModelPreset = 'multilingual-e5-small';
        setCurrentModel(defaultModel);
        await saveModelPreference(defaultModel);
      }

      await saveVersionPreference('quantized');

      if (result.modelState) {
        const modelState = result.modelState;
        if (modelState.status === 'ready') {
          setModelInitializationStatus('ready');
          setModelDownloadProgress(modelState.downloadProgress || 100);
          setIsModelDownloading(false);
        } else {
          setModelInitializationStatus('idle');
          setModelDownloadProgress(0);
          setIsModelDownloading(false);
          await saveModelState('idle', 0, false);
        }
      } else {
        setModelInitializationStatus('idle');
        setModelDownloadProgress(0);
        setIsModelDownloading(false);
      }

      if (result.semanticEngineState) {
        const semanticState = result.semanticEngineState;
        if (semanticState.status === 'ready') {
          setSemanticEngineStatus('ready');
          setSemanticEngineLastUpdated(semanticState.lastUpdated || Date.now());
        } else if (semanticState.status === 'error') {
          setSemanticEngineStatus('error');
          setSemanticEngineLastUpdated(semanticState.lastUpdated || Date.now());
        } else {
          setSemanticEngineStatus('idle');
        }
      } else {
        setSemanticEngineStatus('idle');
      }
    } catch (error) {
      console.error('❌ Failed to load model preferences:', error);
    }
  }

  function hideClearDataConfirmation() {
    setShowClearConfirmation(false);
  }

  async function confirmClearAllData() {
    if (isClearingData) {
      return;
    }

    setIsClearingData(true);
    setClearDataProgress(getMessage('clearingStatus'));

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'clear_all_data',
      });

      if (!response?.success) {
        throw new Error(response?.error || 'Failed to clear data');
      }

      setClearDataProgress(getMessage('dataClearedNotification'));
      await refreshStorageStats();

      setTimeout(() => {
        setClearDataProgress('');
        hideClearDataConfirmation();
      }, 2000);
    } catch (error: any) {
      setClearDataProgress(`Failed to clear data: ${error?.message || 'Unknown error'}`);
      setTimeout(() => {
        setClearDataProgress('');
      }, 5000);
    } finally {
      setIsClearingData(false);
    }
  }

  async function openSidepanelAndClose(tab: 'workflows' | 'element-markers' | 'agent-chat') {
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
    showComingSoon('Workflow management');
  }

  function openElementMarkerSidepanel() {
    void openSidepanelAndClose('element-markers');
  }

  function openAgentSidepanel() {
    void openSidepanelAndClose('agent-chat');
  }

  async function toggleWebEditor() {
    try {
      await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TOGGLE });
    } catch (error) {
      console.warn('Failed to switch web page editing mode:', error);
    }
  }

  async function toggleElementMarker() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        return;
      }

      await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_START,
        tabId: tab.id,
      });
    } catch (error) {
      console.warn('Failed to enable element annotation:', error);
    }
  }

  async function openWelcomePage() {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
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

  function startRecording() {
    showComingSoon('Record playback');
  }

  function stopRecording() {
    showComingSoon('Record playback');
  }

  useEffect(() => {
    const onRuntimeMessage = (message: { type?: string; payload?: unknown }) => {
      if (message.type === BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED && message.payload) {
        setServerStatus(message.payload as ServerStatus);
      }
    };

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local') {
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
      await loadPortPreference();
      await loadModelPreference();
      await checkNativeConnection();
      await checkServerStatus();
      await refreshStorageStats();
      await loadCacheStats();
      await checkSemanticEngineStatus();
    })();

    return () => {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);

      stopModelStatusMonitoring();
      stopSemanticEngineStatusPolling();

      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
      if (copyTextTimerRef.current) {
        clearTimeout(copyTextTimerRef.current);
      }
    };
  }, []);

  return (
    <div className="popup-container agent-theme" data-agent-theme={agentTheme}>
      {currentView === 'home' ? (
        <div className="home-view">
          <div className="header">
            <div className="header-content">
              <h1 className="header-title">Webpage MCP Server</h1>
            </div>
          </div>

          <div className="content">
            <div className="section">
              <h2 className="section-title">{getMessage('nativeServerConfigLabel')}</h2>
              <div className="config-card">
                <div className="status-section">
                  <div className="status-header">
                    <p className="status-label">{getMessage('runningStatusLabel')}</p>
                    <button
                      className="refresh-status-button"
                      type="button"
                      onClick={() => void refreshServerStatus()}
                      title={getMessage('refreshStatusButton')}
                    >
                      <RefreshIcon className="icon-small" />
                    </button>
                  </div>
                  <div className="status-info">
                    <span className={`status-dot ${getStatusClass()}`} />
                    <span className="status-text">{getStatusText()}</span>
                  </div>
                  {serverStatus.lastUpdated ? (
                    <div className="status-timestamp">
                      {getMessage('lastUpdatedLabel')} {new Date(serverStatus.lastUpdated).toLocaleTimeString()}
                    </div>
                  ) : null}
                </div>

                {showMcpConfig ? (
                  <div className="mcp-config-section">
                    <div className="mcp-config-header">
                      <p className="mcp-config-label">{getMessage('mcpServerConfigLabel')}</p>
                      <button className="copy-config-button" type="button" onClick={() => void copyMcpConfig()}>
                        {copyButtonText}
                      </button>
                    </div>
                    <div className="mcp-config-content">
                      <pre className="mcp-config-json">{mcpConfigJson}</pre>
                    </div>
                  </div>
                ) : null}

                <div className="port-section">
                  <label htmlFor="port" className="port-label">
                    {getMessage('connectionPortLabel')}
                  </label>
                  <input
                    type="text"
                    id="port"
                    value={nativeServerPort}
                    onChange={(event) => void updatePort(event)}
                    className="port-input"
                  />
                </div>

                <button
                  className="connect-button"
                  type="button"
                  disabled={isConnecting}
                  onClick={() => void testNativeConnection()}
                >
                  <BoltIcon />
                  <span>
                    {isConnecting
                      ? getMessage('connectingStatus')
                      : nativeConnectionStatus === 'connected'
                        ? getMessage('disconnectButton')
                        : getMessage('connectButton')}
                  </span>
                </button>
              </div>
            </div>

            <div className="section">
              <h2 className="section-title">Quick tools</h2>
              <div className="rr-icon-buttons">
                <button
                  className="rr-icon-btn rr-icon-btn-record rr-icon-btn-coming-soon has-tooltip"
                  type="button"
                  onClick={startRecording}
                  data-tooltip="The recording function is under development"
                >
                  <RecordIcon recording={false} />
                </button>
                <button
                  className="rr-icon-btn rr-icon-btn-stop rr-icon-btn-coming-soon has-tooltip"
                  type="button"
                  onClick={stopRecording}
                  data-tooltip="The recording function is under development"
                >
                  <StopIcon />
                </button>
                <button
                  className="rr-icon-btn rr-icon-btn-edit has-tooltip"
                  type="button"
                  onClick={() => void toggleWebEditor()}
                  data-tooltip="Turn on page editing mode"
                >
                  <EditIcon />
                </button>
                <button
                  className="rr-icon-btn rr-icon-btn-marker has-tooltip"
                  type="button"
                  onClick={() => void toggleElementMarker()}
                  data-tooltip="Turn on element annotation"
                >
                  <MarkerIcon />
                </button>
              </div>
            </div>

            <div className="section">
              <h2 className="section-title">Management portal</h2>
              <div className="entry-card">
                <button className="entry-item" type="button" onClick={openAgentSidepanel}>
                  <div className="entry-icon agent">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                      />
                    </svg>
                  </div>
                  <div className="entry-content">
                    <span className="entry-title">Intelligent Assistant</span>
                    <span className="entry-desc">AI Agent Conversations and Quests</span>
                  </div>
                  <svg className="entry-arrow" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>

                <button className="entry-item entry-item-coming-soon" type="button" onClick={openWorkflowSidepanel}>
                  <div className="entry-icon workflow">
                    <WorkflowIcon />
                  </div>
                  <div className="entry-content">
                    <span className="entry-title">
                      Workflow management
                      <span className="coming-soon-badge">Coming Soon</span>
                    </span>
                    <span className="entry-desc">Recording and playback automation process</span>
                  </div>
                  <svg className="entry-arrow" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>

                <button className="entry-item" type="button" onClick={openElementMarkerSidepanel}>
                  <div className="entry-icon marker">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                      />
                    </svg>
                  </div>
                  <div className="entry-content">
                    <span className="entry-title">Element annotation management</span>
                    <span className="entry-desc">Manage page element annotations</span>
                  </div>
                  <svg className="entry-arrow" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>

                <button className="entry-item" type="button" onClick={() => setCurrentView('local-model')}>
                  <div className="entry-icon model">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                  <div className="entry-content">
                    <span className="entry-title">Local model</span>
                    <span className="entry-desc">Semantic engine and model management</span>
                  </div>
                  <svg className="entry-arrow" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <div className="footer">
            <div className="footer-links">
              <button className="footer-link" type="button" onClick={() => void openWelcomePage()} title="View installation guide">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                Guide
              </button>
              <button className="footer-link" type="button" onClick={() => void openTroubleshooting()} title="Troubleshooting">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                  />
                </svg>
                Docs
              </button>
            </div>
            <p className="footer-text">webpage mcp server for ai</p>
          </div>
        </div>
      ) : null}

      {currentView === 'local-model' ? (
        <LocalModelPage
          semanticEngineStatus={semanticEngineStatus}
          isSemanticEngineInitializing={isSemanticEngineInitializing}
          semanticEngineInitProgress={semanticEngineInitProgress}
          semanticEngineLastUpdated={semanticEngineLastUpdated}
          availableModels={availableModels}
          currentModel={currentModel}
          isModelSwitching={isModelSwitching}
          isModelDownloading={isModelDownloading}
          modelDownloadProgress={modelDownloadProgress}
          modelInitializationStatus={modelInitializationStatus}
          modelErrorMessage={modelErrorMessage}
          modelErrorType={modelErrorType}
          storageStats={storageStats}
          isClearingData={isClearingData}
          clearDataProgress={clearDataProgress}
          cacheStats={cacheStats}
          isManagingCache={isManagingCache}
          onBack={() => setCurrentView('home')}
          onInitializeSemanticEngine={() => void initializeSemanticEngine()}
          onSwitchModel={(preset) => void switchModel(preset as ModelPreset)}
          onRetryModelInitialization={() => void retryModelInitialization()}
          onShowClearConfirmation={() => setShowClearConfirmation(true)}
          onCleanupCache={() => void cleanupCache()}
          onClearAllCache={() => void clearAllCache()}
        />
      ) : null}

      <ConfirmDialog
        visible={showClearConfirmation}
        title={getMessage('confirmClearDataTitle')}
        message={getMessage('clearDataWarningMessage')}
        items={[getMessage('clearDataList1'), getMessage('clearDataList2'), getMessage('clearDataList3')]}
        warning={getMessage('clearDataIrreversibleWarning')}
        icon="⚠️"
        confirmText={getMessage('confirmClearButton')}
        cancelText={getMessage('cancelButton')}
        confirmingText={getMessage('clearingStatus')}
        isConfirming={isClearingData}
        onConfirm={() => void confirmClearAllData()}
        onCancel={hideClearDataConfirmation}
      />

      {comingSoonToast.show ? (
        <div className="coming-soon-toast">
          <svg className="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 6v6l4 2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{comingSoonToast.feature} The function is under development, please stay tuned</span>
        </div>
      ) : null}
    </div>
  );
}
