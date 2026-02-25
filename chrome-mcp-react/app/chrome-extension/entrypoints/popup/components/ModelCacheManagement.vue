<template>
  <div class="model-cache-section">
    <h2 class="section-title">{{ getMessage('modelCacheManagementLabel') }}</h2>

    <!-- Cache Statistics Grid -->
    <div class="stats-grid">
      <div class="stats-card">
        <div class="stats-header">
          <p class="stats-label">{{ getMessage('cacheSizeLabel') }}</p>
          <span class="stats-icon orange">
            <DatabaseIcon />
          </span>
        </div>
        <p class="stats-value">{{ cacheStats?.totalSizeMB || 0 }} MB</p>
      </div>

      <div class="stats-card">
        <div class="stats-header">
          <p class="stats-label">{{ getMessage('cacheEntriesLabel') }}</p>
          <span class="stats-icon purple">
            <VectorIcon />
          </span>
        </div>
        <p class="stats-value">{{ cacheStats?.entryCount || 0 }}</p>
      </div>
    </div>

    <!-- Cache Entries Details -->
    <div v-if="cacheStats && cacheStats.entries.length > 0" class="cache-details">
      <h3 class="cache-details-title">{{ getMessage('cacheDetailsLabel') }}</h3>
      <div class="cache-entries">
        <div v-for="entry in cacheStats.entries" :key="entry.url" class="cache-entry">
          <div class="entry-info">
            <div class="entry-url">{{ getModelNameFromUrl(entry.url) }}</div>
            <div class="entry-details">
              <span class="entry-size">{{ entry.sizeMB }} MB</span>
              <span class="entry-age">{{ entry.age }}</span>
              <span v-if="entry.expired" class="entry-expired">{{ getMessage('expiredLabel') }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- No Cache Message -->
    <div v-else-if="cacheStats && cacheStats.entries.length === 0" class="no-cache">
      <p>{{ getMessage('noCacheDataMessage') }}</p>
    </div>

    <!-- Loading State -->
    <div v-else-if="!cacheStats" class="loading-cache">
      <p>{{ getMessage('loadingCacheInfoStatus') }}</p>
    </div>

    <!-- Progress Indicator -->
    <ProgressIndicator
      v-if="isManagingCache"
      :visible="isManagingCache"
      :text="isManagingCache ? getMessage('processingCacheStatus') : ''"
      :showSpinner="true"
    />

    <!-- Action Buttons -->
    <div class="cache-actions">
      <div class="secondary-button" :disabled="isManagingCache" @click="$emit('cleanup-cache')">
        <span class="stats-icon"><DatabaseIcon /></span>
        <span>{{
          isManagingCache ? getMessage('cleaningStatus') : getMessage('cleanExpiredCacheButton')
        }}</span>
      </div>

      <div class="danger-button" :disabled="isManagingCache" @click="$emit('clear-all-cache')">
        <span class="stats-icon"><TrashIcon /></span>
        <span>{{ isManagingCache ? getMessage('clearingStatus') : getMessage('clearAllCacheButton') }}</span>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import ProgressIndicator from './ProgressIndicator.vue';
import { DatabaseIcon, VectorIcon, TrashIcon } from './icons';
import { getMessage } from '@/utils/i18n';

interface CacheEntry {
  url: string;
  size: number;
  sizeMB: number;
  timestamp: number;
  age: string;
  expired: boolean;
}

interface CacheStats {
  totalSize: number;
  totalSizeMB: number;
  entryCount: number;
  entries: CacheEntry[];
}

interface Props {
  cacheStats: CacheStats | null;
  isManagingCache: boolean;
}

interface Emits {
  (e: 'cleanup-cache'): void;
  (e: 'clear-all-cache'): void;
}

defineProps<Props>();
defineEmits<Emits>();

const getModelNameFromUrl = (url: string) => {
  // Extract model name from HuggingFace URL
  const match = url.match(/huggingface\.co\/([^/]+\/[^/]+)/);
  if (match) {
    return match[1];
  }
  return url.split('/').pop() || url;
};
</script>

<style scoped>
.model-cache-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 12px;
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
}

.stats-card {
  background: white;
  border-radius: 12px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  padding: 16px;
}

.stats-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.stats-label {
  font-size: 14px;
  font-weight: 500;
  color: #64748b;
}

.stats-icon {
  padding: 8px;
  border-radius: 8px;
  width: 36px;
  height: 36px;
}

.stats-icon.orange {
  background: #fed7aa;
  color: #ea580c;
}

.stats-icon.purple {
  background: #e9d5ff;
  color: #9333ea;
}

.stats-value {
  font-size: 30px;
  font-weight: 700;
  color: #0f172a;
  margin: 0;
}

.cache-details {
  margin-bottom: 16px;
}

.cache-details-title {
  font-size: 14px;
  font-weight: 600;
  color: #374151;
  margin: 0 0 12px 0;
}

.cache-entries {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cache-entry {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
}

.entry-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.entry-url {
  font-weight: 500;
  color: #1f2937;
  font-size: 14px;
}

.entry-details {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}

.entry-size {
  background: #dbeafe;
  color: #1e40af;
  padding: 2px 6px;
  border-radius: 4px;
}

.entry-age {
  color: #6b7280;
}

.entry-expired {
  background: #fee2e2;
  color: #dc2626;
  padding: 2px 6px;
  border-radius: 4px;
}

.no-cache,
.loading-cache {
  text-align: center;
  color: #6b7280;
  padding: 20px;
  background: #f8fafc;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  margin-bottom: 16px;
}

.cache-actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.secondary-button {
  background: #f1f5f9;
  color: #475569;
  border: 1px solid #cbd5e1;
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  justify-content: center;
  user-select: none;
  cursor: pointer;
}

.secondary-button:hover:not(:disabled) {
  background: #e2e8f0;
  border-color: #94a3b8;
}

.secondary-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.danger-button {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: white;
  border: 1px solid #d1d5db;
  color: #374151;
  font-weight: 600;
  padding: 12px 16px;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
  transition: all 0.2s ease;
}

.danger-button:hover:not(:disabled) {
  border-color: #ef4444;
  color: #dc2626;
}

.danger-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
