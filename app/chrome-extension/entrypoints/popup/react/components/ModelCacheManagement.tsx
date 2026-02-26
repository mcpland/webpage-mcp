import { getMessage } from "@/utils/i18n";

import { DatabaseIcon, TrashIcon, VectorIcon } from "../icons";
import { ProgressIndicator } from "./ProgressIndicator";
import "./ModelCacheManagement.css";

export type CacheEntry = {
  url: string;
  size: number;
  sizeMB: number;
  timestamp: number;
  age: string;
  expired: boolean;
};

export type CacheStats = {
  totalSize: number;
  totalSizeMB: number;
  entryCount: number;
  entries: CacheEntry[];
};

export type ModelCacheManagementProps = {
  cacheStats: CacheStats | null;
  isManagingCache: boolean;
  onCleanupCache: () => void;
  onClearAllCache: () => void;
};

function getModelNameFromUrl(url: string): string {
  const match = url.match(/huggingface\.co\/([^/]+\/[^/]+)/);
  if (match) {
    return match[1];
  }
  return url.split("/").pop() || url;
}

export function ModelCacheManagement({
  cacheStats,
  isManagingCache,
  onCleanupCache,
  onClearAllCache,
}: ModelCacheManagementProps) {
  return (
    <div className="model-cache-section">
      <h2 className="section-title">{getMessage("modelCacheManagementLabel")}</h2>

      <div className="stats-grid">
        <div className="stats-card">
          <div className="stats-header">
            <p className="stats-label">{getMessage("cacheSizeLabel")}</p>
            <span className="stats-icon orange">
              <DatabaseIcon />
            </span>
          </div>
          <p className="stats-value">{cacheStats?.totalSizeMB || 0} MB</p>
        </div>

        <div className="stats-card">
          <div className="stats-header">
            <p className="stats-label">{getMessage("cacheEntriesLabel")}</p>
            <span className="stats-icon purple">
              <VectorIcon />
            </span>
          </div>
          <p className="stats-value">{cacheStats?.entryCount || 0}</p>
        </div>
      </div>

      {cacheStats && cacheStats.entries.length > 0 ? (
        <div className="cache-details">
          <h3 className="cache-details-title">{getMessage("cacheDetailsLabel")}</h3>
          <div className="cache-entries">
            {cacheStats.entries.map((entry) => (
              <div className="cache-entry" key={entry.url}>
                <div className="entry-info">
                  <div className="entry-url">{getModelNameFromUrl(entry.url)}</div>
                  <div className="entry-details">
                    <span className="entry-size">{entry.sizeMB} MB</span>
                    <span className="entry-age">{entry.age}</span>
                    {entry.expired ? (
                      <span className="entry-expired">{getMessage("expiredLabel")}</span>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {cacheStats && cacheStats.entries.length === 0 ? (
        <div className="no-cache">
          <p>{getMessage("noCacheDataMessage")}</p>
        </div>
      ) : null}

      {!cacheStats ? (
        <div className="loading-cache">
          <p>{getMessage("loadingCacheInfoStatus")}</p>
        </div>
      ) : null}

      {isManagingCache ? (
        <ProgressIndicator
          visible={isManagingCache}
          text={isManagingCache ? getMessage("processingCacheStatus") : ""}
          showSpinner
        />
      ) : null}

      <div className="cache-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={isManagingCache}
          onClick={onCleanupCache}
        >
          <span className="stats-icon">
            <DatabaseIcon />
          </span>
          <span>
            {isManagingCache ? getMessage("cleaningStatus") : getMessage("cleanExpiredCacheButton")}
          </span>
        </button>

        <button
          type="button"
          className="danger-button"
          disabled={isManagingCache}
          onClick={onClearAllCache}
        >
          <span className="stats-icon">
            <TrashIcon />
          </span>
          <span>{isManagingCache ? getMessage("clearingStatus") : getMessage("clearAllCacheButton")}</span>
        </button>
      </div>
    </div>
  );
}
