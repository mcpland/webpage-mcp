import { getMessage } from "@/utils/i18n";

import {
  BoltIcon,
  CheckIcon,
  DatabaseIcon,
  DocumentIcon,
  TabIcon,
  TrashIcon,
  VectorIcon,
} from "../icons";
import { ModelCacheManagement, type CacheStats } from "./ModelCacheManagement";
import { ProgressIndicator } from "./ProgressIndicator";
import "./LocalModelPage.css";

export type SemanticEngineStatus = "idle" | "initializing" | "ready" | "error";

export type LocalModelPreset = {
  preset: string;
  performance: string;
  size: string;
  dimension: number;
};

export type StorageStats = {
  indexedPages: number;
  totalDocuments: number;
  totalTabs: number;
  indexSize: number;
  isInitialized: boolean;
};

export type LocalModelPageProps = {
  semanticEngineStatus: SemanticEngineStatus;
  isSemanticEngineInitializing: boolean;
  semanticEngineInitProgress: string;
  semanticEngineLastUpdated: number | null;
  availableModels: LocalModelPreset[];
  currentModel: string | null;
  isModelSwitching: boolean;
  isModelDownloading: boolean;
  modelDownloadProgress: number;
  modelInitializationStatus: string;
  modelErrorMessage: string;
  modelErrorType: string;
  storageStats: StorageStats | null;
  isClearingData: boolean;
  clearDataProgress: string;
  cacheStats: CacheStats | null;
  isManagingCache: boolean;
  onBack: () => void;
  onInitializeSemanticEngine: () => void;
  onSwitchModel: (preset: string) => void;
  onRetryModelInitialization: () => void;
  onShowClearConfirmation: () => void;
  onCleanupCache: () => void;
  onClearAllCache: () => void;
};

function getSemanticEngineStatusClass(status: SemanticEngineStatus): string {
  switch (status) {
    case "ready":
      return "bg-emerald-500";
    case "initializing":
      return "bg-yellow-500";
    case "error":
      return "bg-red-500";
    case "idle":
    default:
      return "bg-gray-500";
  }
}

function getSemanticEngineStatusText(status: SemanticEngineStatus): string {
  switch (status) {
    case "ready":
      return getMessage("semanticEngineReadyStatus");
    case "initializing":
      return getMessage("semanticEngineInitializingStatus");
    case "error":
      return getMessage("semanticEngineInitFailedStatus");
    case "idle":
    default:
      return getMessage("semanticEngineNotInitStatus");
  }
}

function getSemanticEngineButtonText(status: SemanticEngineStatus): string {
  switch (status) {
    case "ready":
      return getMessage("reinitializeButton");
    case "initializing":
      return getMessage("initializingStatus");
    case "error":
      return getMessage("reinitializeButton");
    case "idle":
    default:
      return getMessage("initSemanticEngineButton");
  }
}

function getModelDescription(model: LocalModelPreset): string {
  switch (model.preset) {
    case "multilingual-e5-small":
      return getMessage("lightweightModelDescription");
    case "multilingual-e5-base":
      return getMessage("betterThanSmallDescription");
    default:
      return getMessage("multilingualModelDescription");
  }
}

function getPerformanceText(performance: string): string {
  switch (performance) {
    case "fast":
      return getMessage("fastPerformance");
    case "balanced":
      return getMessage("balancedPerformance");
    case "accurate":
      return getMessage("accuratePerformance");
    default:
      return performance;
  }
}

function getErrorTypeText(type: string): string {
  switch (type) {
    case "network":
      return getMessage("networkErrorMessage");
    case "file":
      return getMessage("modelCorruptedErrorMessage");
    case "unknown":
    default:
      return getMessage("unknownErrorMessage");
  }
}

function formatIndexSize(storageStats: StorageStats | null): string {
  if (!storageStats?.indexSize) return "0 MB";
  const sizeInMB = Math.round(storageStats.indexSize / (1024 * 1024));
  return `${sizeInMB} MB`;
}

export function LocalModelPage({
  semanticEngineStatus,
  isSemanticEngineInitializing,
  semanticEngineInitProgress,
  semanticEngineLastUpdated,
  availableModels,
  currentModel,
  isModelSwitching,
  isModelDownloading,
  modelDownloadProgress,
  modelInitializationStatus,
  modelErrorMessage,
  modelErrorType,
  storageStats,
  isClearingData,
  clearDataProgress,
  cacheStats,
  isManagingCache,
  onBack,
  onInitializeSemanticEngine,
  onSwitchModel,
  onRetryModelInitialization,
  onShowClearConfirmation,
  onCleanupCache,
  onClearAllCache,
}: LocalModelPageProps) {
  const progressText = isModelDownloading
    ? getMessage("downloadingModelStatus", [modelDownloadProgress.toString()])
    : isModelSwitching
      ? getMessage("switchingModelStatus")
      : "";

  return (
    <div className="local-model-page">
      <div className="page-header">
        <button type="button" className="back-button" onClick={onBack} title="返回首页">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          <span>返回</span>
        </button>
        <h2 className="page-title">本地模型</h2>
      </div>

      <div className="page-content">
        <div className="section">
          <h3 className="section-title">{getMessage("semanticEngineLabel")}</h3>
          <div className="semantic-engine-card">
            <div className="semantic-engine-status">
              <div className="status-info">
                <span className={`status-dot ${getSemanticEngineStatusClass(semanticEngineStatus)}`} />
                <span className="status-text">{getSemanticEngineStatusText(semanticEngineStatus)}</span>
              </div>
              {semanticEngineLastUpdated ? (
                <div className="status-timestamp">
                  {getMessage("lastUpdatedLabel")} {new Date(semanticEngineLastUpdated).toLocaleTimeString()}
                </div>
              ) : null}
            </div>

            {isSemanticEngineInitializing ? (
              <ProgressIndicator
                visible={isSemanticEngineInitializing}
                text={semanticEngineInitProgress}
                showSpinner
              />
            ) : null}

            <button
              type="button"
              className="primary-action-button"
              disabled={isSemanticEngineInitializing}
              onClick={onInitializeSemanticEngine}
            >
              <BoltIcon />
              <span>{getSemanticEngineButtonText(semanticEngineStatus)}</span>
            </button>
          </div>
        </div>

        <div className="section">
          <h3 className="section-title">{getMessage("embeddingModelLabel")}</h3>

          {isModelSwitching || isModelDownloading ? (
            <ProgressIndicator visible={isModelSwitching || isModelDownloading} text={progressText} showSpinner />
          ) : null}

          {modelInitializationStatus === "error" ? (
            <div className="error-card">
              <div className="error-content">
                <div className="error-icon">⚠️</div>
                <div className="error-details">
                  <p className="error-title">{getMessage("semanticEngineInitFailedStatus")}</p>
                  <p className="error-message">
                    {modelErrorMessage || getMessage("semanticEngineInitFailedStatus")}
                  </p>
                  <p className="error-suggestion">{getErrorTypeText(modelErrorType)}</p>
                </div>
              </div>
              <button
                type="button"
                className="retry-button"
                onClick={onRetryModelInitialization}
                disabled={isModelSwitching || isModelDownloading}
              >
                <span>🔄</span>
                <span>{getMessage("retryButton")}</span>
              </button>
            </div>
          ) : null}

          <div className="model-list">
            {availableModels.map((model) => {
              const isSelected = currentModel === model.preset;
              const isDisabled = isModelSwitching || isModelDownloading;

              return (
                <div
                  key={model.preset}
                  className={`model-card${isSelected ? " selected" : ""}${isDisabled ? " disabled" : ""}`}
                  onClick={() => {
                    if (!isDisabled) {
                      onSwitchModel(model.preset);
                    }
                  }}
                >
                  <div className="model-header">
                    <div className="model-info">
                      <p className={`model-name${isSelected ? " selected-text" : ""}`}>{model.preset}</p>
                      <p className="model-description">{getModelDescription(model)}</p>
                    </div>
                    {isSelected ? (
                      <div className="check-icon">
                        <CheckIcon className="text-white" />
                      </div>
                    ) : null}
                  </div>
                  <div className="model-tags">
                    <span className="model-tag performance">{getPerformanceText(model.performance)}</span>
                    <span className="model-tag size">{model.size}</span>
                    <span className="model-tag dimension">{model.dimension}D</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="section">
          <h3 className="section-title">{getMessage("indexDataManagementLabel")}</h3>
          <div className="stats-grid">
            <div className="stats-card">
              <div className="stats-header">
                <p className="stats-label">{getMessage("indexedPagesLabel")}</p>
                <span className="stats-icon violet">
                  <DocumentIcon />
                </span>
              </div>
              <p className="stats-value">{storageStats?.indexedPages || 0}</p>
            </div>

            <div className="stats-card">
              <div className="stats-header">
                <p className="stats-label">{getMessage("indexSizeLabel")}</p>
                <span className="stats-icon teal">
                  <DatabaseIcon />
                </span>
              </div>
              <p className="stats-value">{formatIndexSize(storageStats)}</p>
            </div>

            <div className="stats-card">
              <div className="stats-header">
                <p className="stats-label">{getMessage("activeTabsLabel")}</p>
                <span className="stats-icon blue">
                  <TabIcon />
                </span>
              </div>
              <p className="stats-value">{storageStats?.totalTabs || 0}</p>
            </div>

            <div className="stats-card">
              <div className="stats-header">
                <p className="stats-label">{getMessage("vectorDocumentsLabel")}</p>
                <span className="stats-icon green">
                  <VectorIcon />
                </span>
              </div>
              <p className="stats-value">{storageStats?.totalDocuments || 0}</p>
            </div>
          </div>

          {isClearingData && clearDataProgress ? (
            <ProgressIndicator visible={isClearingData} text={clearDataProgress} showSpinner />
          ) : null}

          <button
            type="button"
            className="danger-action-button"
            disabled={isClearingData}
            onClick={onShowClearConfirmation}
          >
            <TrashIcon />
            <span>{isClearingData ? getMessage("clearingStatus") : getMessage("clearAllDataButton")}</span>
          </button>
        </div>

        <ModelCacheManagement
          cacheStats={cacheStats}
          isManagingCache={isManagingCache}
          onCleanupCache={onCleanupCache}
          onClearAllCache={onClearAllCache}
        />
      </div>
    </div>
  );
}
