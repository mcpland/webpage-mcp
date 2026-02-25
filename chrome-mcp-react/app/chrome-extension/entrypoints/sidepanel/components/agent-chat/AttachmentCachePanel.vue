<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center"
    role="dialog"
    aria-modal="true"
    aria-label="Attachment cache management"
    @click.self="handleClose"
  >
    <!-- Backdrop -->
    <div class="absolute inset-0 bg-black/40" />

    <!-- Panel -->
    <div
      class="relative w-full max-w-2xl mx-4 max-h-[85vh] overflow-hidden flex flex-col"
      :style="{
        backgroundColor: 'var(--ac-surface, #ffffff)',
        border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
        borderRadius: 'var(--ac-radius-card, 12px)',
        boxShadow: 'var(--ac-shadow-float, 0 4px 20px -2px rgba(0,0,0,0.2))',
      }"
    >
      <!-- Header -->
      <div
        class="flex items-start justify-between px-4 py-3 gap-3"
        :style="{ borderBottom: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)' }"
      >
        <div class="min-w-0">
          <h2 class="text-sm font-semibold" :style="{ color: 'var(--ac-text, #1a1a1a)' }">
            Attachment Cache
          </h2>
          <p class="text-[10px] mt-0.5" :style="{ color: 'var(--ac-text-subtle, #a8a29e)' }">
            Manage cached images stored on disk by the agent server.
          </p>
        </div>

        <div class="flex items-center gap-2 flex-shrink-0">
          <!-- Refresh button -->
          <button
            type="button"
            class="p-1 ac-btn"
            :disabled="!serverReady || isLoading || isClearing"
            :style="{
              color: 'var(--ac-text-muted, #6e6e6e)',
              borderRadius: 'var(--ac-radius-button, 8px)',
              opacity: !serverReady || isLoading || isClearing ? 0.6 : 1,
            }"
            title="Refresh"
            @click="refresh"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M4 4v6h6M20 20v-6h-6M20 8a8 8 0 00-14.828-2M4 16a8 8 0 0014.828 2"
              />
            </svg>
          </button>

          <!-- Close button -->
          <button
            type="button"
            class="p-1 ac-btn"
            :style="{
              color: 'var(--ac-text-muted, #6e6e6e)',
              borderRadius: 'var(--ac-radius-button, 8px)',
            }"
            aria-label="Close"
            @click="handleClose"
          >
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-y-auto ac-scroll px-4 py-3 space-y-4">
        <!-- Server not ready -->
        <div v-if="!serverReady" class="py-10 text-center">
          <div class="text-sm" :style="{ color: 'var(--ac-text-muted, #6e6e6e)' }">
            Agent server not ready.
          </div>
          <div class="text-[10px] mt-1" :style="{ color: 'var(--ac-text-subtle, #a8a29e)' }">
            Start or reconnect the server, then open this panel again.
          </div>
        </div>

        <!-- Loading -->
        <div v-else-if="isLoading && !stats" class="py-10 text-center">
          <div
            class="inline-flex items-center gap-2 text-sm"
            :style="{ color: 'var(--ac-text-muted, #6e6e6e)' }"
          >
            <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                stroke-width="4"
              />
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
            Loading attachment stats...
          </div>
        </div>

        <!-- Error -->
        <div v-else-if="errorMessage" class="space-y-3">
          <div
            class="px-4 py-3 text-xs rounded-lg"
            :style="{
              backgroundColor: 'var(--ac-diff-del-bg)',
              color: 'var(--ac-danger)',
              border: 'var(--ac-border-width) solid var(--ac-diff-del-border)',
              borderRadius: 'var(--ac-radius-inner)',
            }"
          >
            {{ errorMessage }}
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="px-3 py-2 text-xs font-medium cursor-pointer"
              :style="{
                backgroundColor: 'var(--ac-chip-bg)',
                color: 'var(--ac-chip-text)',
                border: 'var(--ac-border-width) solid var(--ac-chip-border)',
                borderRadius: 'var(--ac-radius-button)',
              }"
              :disabled="isLoading || isClearing"
              @click="refresh"
            >
              Retry
            </button>
            <button
              type="button"
              class="px-3 py-2 text-xs font-medium cursor-pointer"
              :style="{
                backgroundColor: 'transparent',
                color: 'var(--ac-text-muted)',
                borderRadius: 'var(--ac-radius-button)',
              }"
              @click="handleClose"
            >
              Close
            </button>
          </div>
        </div>

        <!-- Loaded -->
        <template v-else-if="stats">
          <!-- Summary -->
          <div class="grid grid-cols-2 gap-3">
            <div
              class="px-3 py-2 rounded-lg"
              :style="{
                backgroundColor: 'var(--ac-surface-muted)',
                border: 'var(--ac-border-width) solid var(--ac-border)',
              }"
            >
              <div
                class="text-[10px] font-bold uppercase tracking-wider"
                :style="{ color: 'var(--ac-text-subtle)' }"
              >
                Total Size
              </div>
              <div class="text-sm font-semibold" :style="{ color: 'var(--ac-text)' }">
                {{ formatBytes(totalBytes) }}
              </div>
              <div class="text-[10px]" :style="{ color: 'var(--ac-text-muted)' }">
                {{ totalFiles.toLocaleString() }} files
              </div>
            </div>

            <div
              class="px-3 py-2 rounded-lg"
              :style="{
                backgroundColor: 'var(--ac-surface-muted)',
                border: 'var(--ac-border-width) solid var(--ac-border)',
              }"
            >
              <div
                class="text-[10px] font-bold uppercase tracking-wider"
                :style="{ color: 'var(--ac-text-subtle)' }"
              >
                Root Directory
              </div>
              <div
                class="text-[11px] font-mono truncate"
                :style="{ color: 'var(--ac-text)' }"
                :title="stats.rootDir"
              >
                {{ stats.rootDir || '-' }}
              </div>
              <div
                v-if="orphanProjectIds.length > 0"
                class="text-[10px] mt-0.5"
                :style="{ color: 'var(--ac-text-subtle)' }"
              >
                {{ orphanProjectIds.length }} orphan project{{
                  orphanProjectIds.length === 1 ? '' : 's'
                }}
              </div>
            </div>
          </div>

          <!-- Selection Controls -->
          <div class="flex items-center justify-between gap-3">
            <div
              class="text-[10px] font-bold uppercase tracking-wider"
              :style="{ color: 'var(--ac-text-subtle, #a8a29e)' }"
            >
              Projects
            </div>

            <div class="flex items-center gap-1.5 flex-wrap justify-end">
              <button
                type="button"
                class="px-2 py-1 text-[11px] font-medium cursor-pointer"
                :style="chipStyle"
                :disabled="isClearing || selectableProjectIds.length === 0"
                @click="selectAll"
              >
                Select all
              </button>
              <button
                type="button"
                class="px-2 py-1 text-[11px] font-medium cursor-pointer"
                :style="chipStyle"
                :disabled="isClearing || selectableProjectIds.length === 0"
                @click="invertSelection"
              >
                Invert
              </button>
              <button
                type="button"
                class="px-2 py-1 text-[11px] font-medium cursor-pointer"
                :style="chipStyle"
                :disabled="isClearing || selectedCount === 0"
                @click="clearSelection"
              >
                Clear
              </button>
            </div>
          </div>

          <!-- Project List -->
          <div v-if="projectsSorted.length === 0" class="py-8 text-center">
            <div class="text-sm" :style="{ color: 'var(--ac-text-muted, #6e6e6e)' }">
              No attachment data found.
            </div>
          </div>

          <div v-else class="space-y-2">
            <div
              v-for="p in projectsSorted"
              :key="p.projectId"
              class="flex items-start gap-3 px-3 py-2 rounded-lg"
              :style="{
                backgroundColor: 'var(--ac-hover-bg-subtle)',
                border: 'var(--ac-border-width) solid var(--ac-border)',
                opacity: isClearing ? 0.7 : 1,
              }"
            >
              <input
                type="checkbox"
                class="mt-0.5"
                :checked="isSelected(p.projectId)"
                :disabled="isClearing || !isSelectable(p)"
                :style="{ accentColor: 'var(--ac-accent)' }"
                @change="toggleProject(p.projectId)"
              />

              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 min-w-0">
                  <div
                    class="text-xs font-medium truncate"
                    :style="{ color: 'var(--ac-text)' }"
                    :title="projectTitle(p)"
                  >
                    {{ projectTitle(p) }}
                  </div>
                  <span
                    v-if="isOrphanProject(p.projectId)"
                    class="text-[10px] px-1.5 py-0.5 rounded"
                    :style="{
                      backgroundColor: 'var(--ac-accent-subtle)',
                      color: 'var(--ac-text)',
                    }"
                  >
                    orphan
                  </span>
                  <span
                    v-if="!p.exists"
                    class="text-[10px] px-1.5 py-0.5 rounded"
                    :style="{
                      backgroundColor: 'var(--ac-chip-bg)',
                      color: 'var(--ac-text-muted)',
                      border: 'var(--ac-border-width) solid var(--ac-chip-border)',
                    }"
                  >
                    missing
                  </span>
                </div>

                <div
                  class="text-[10px] mt-0.5 flex flex-wrap items-center gap-2"
                  :style="{ color: 'var(--ac-text-subtle)' }"
                >
                  <span>{{ p.fileCount.toLocaleString() }} files</span>
                  <span class="opacity-50">&middot;</span>
                  <span>{{ formatBytes(p.totalBytes) }}</span>
                </div>
              </div>

              <div class="text-right flex-shrink-0">
                <div class="text-[11px] font-mono" :style="{ color: 'var(--ac-text-muted)' }">
                  {{ formatBytes(p.totalBytes) }}
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- Footer -->
      <div
        class="flex-none px-4 py-3 flex items-center justify-between gap-3"
        :style="{ borderTop: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)' }"
      >
        <div class="text-[10px] min-w-0" :style="{ color: 'var(--ac-text-subtle)' }">
          <span v-if="statusMessage">{{ statusMessage }}</span>
          <span v-else> Select projects to remove cached attachment files from disk. </span>
        </div>

        <button
          type="button"
          class="px-3 py-2 text-xs font-semibold rounded-lg flex-shrink-0 cursor-pointer"
          :disabled="!canClear"
          :style="clearButtonStyle"
          @click="clearSelected"
        >
          {{ isClearing ? 'Clearing...' : `Clear Selected (${selectedCount})` }}
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, inject, onUnmounted, ref, watch } from 'vue';
import type {
  AttachmentCleanupResponse,
  AttachmentProjectStats,
  AttachmentStatsResponse,
} from 'webpage-mcp-shared';
import { AGENT_SERVER_PORT_KEY } from '../../composables';

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

// Inject server port from parent
const serverPort = inject(AGENT_SERVER_PORT_KEY, ref<number | null>(null));

// Compute base URL for API requests
const baseUrl = computed(() => {
  const port = serverPort.value;
  if (port === null) return null;
  if (!Number.isInteger(port) || port <= 0) return null;
  return `http://127.0.0.1:${port}`;
});

const serverReady = computed(() => baseUrl.value !== null);

// State
const stats = ref<AttachmentStatsResponse | null>(null);
const isLoading = ref(false);
const isClearing = ref(false);
const errorMessage = ref<string | null>(null);
const statusMessage = ref<string | null>(null);
const selectedProjectIds = ref<Set<string>>(new Set());

// Derived state
const totalBytes = computed(() => stats.value?.totalBytes ?? 0);
const totalFiles = computed(() => stats.value?.totalFiles ?? 0);
const orphanProjectIds = computed(() => stats.value?.orphanProjectIds ?? []);
const projects = computed(() => stats.value?.projects ?? []);

const projectsSorted = computed<AttachmentProjectStats[]>(() => {
  return [...projects.value].sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0));
});

/**
 * Check if a project can be selected (has files that exist).
 */
function isSelectable(p: AttachmentProjectStats): boolean {
  return p.exists === true && p.fileCount > 0;
}

const selectableProjectIds = computed(() =>
  projectsSorted.value.filter(isSelectable).map((p) => p.projectId),
);

const selectedCount = computed(() => selectedProjectIds.value.size);

const canClear = computed(() => {
  return serverReady.value && !isLoading.value && !isClearing.value && selectedCount.value > 0;
});

// Styles
const chipStyle = computed(() => ({
  backgroundColor: 'var(--ac-chip-bg)',
  color: 'var(--ac-chip-text)',
  border: 'var(--ac-border-width) solid var(--ac-chip-border)',
  borderRadius: 'var(--ac-radius-button)',
  opacity: isClearing.value ? 0.7 : 1,
}));

const clearButtonStyle = computed(() => {
  if (!canClear.value) {
    return {
      backgroundColor: 'var(--ac-chip-bg)',
      color: 'var(--ac-text-subtle)',
      border: 'var(--ac-border-width) solid var(--ac-border)',
      borderRadius: 'var(--ac-radius-button)',
      opacity: 0.7,
    };
  }
  return {
    backgroundColor: 'var(--ac-diff-del-bg)',
    color: 'var(--ac-danger)',
    border: 'var(--ac-border-width) solid var(--ac-diff-del-border)',
    borderRadius: 'var(--ac-radius-button)',
  };
});

/**
 * Format bytes to human-readable string.
 */
function formatBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const kb = safe / 1024;
  if (kb <= 0) return '0 KB';
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
}

/**
 * Get display title for a project.
 */
function projectTitle(p: AttachmentProjectStats): string {
  return p.projectName?.trim() || p.projectId;
}

/**
 * Check if a project is an orphan (exists on disk but not in database).
 */
function isOrphanProject(projectId: string): boolean {
  return orphanProjectIds.value.includes(projectId);
}

/**
 * Check if a project is selected.
 */
function isSelected(projectId: string): boolean {
  return selectedProjectIds.value.has(projectId);
}

/**
 * Toggle project selection.
 */
function toggleProject(projectId: string): void {
  const next = new Set(selectedProjectIds.value);
  if (next.has(projectId)) {
    next.delete(projectId);
  } else {
    next.add(projectId);
  }
  selectedProjectIds.value = next;
}

/**
 * Select all selectable projects.
 */
function selectAll(): void {
  selectedProjectIds.value = new Set(selectableProjectIds.value);
}

/**
 * Clear all selections.
 */
function clearSelection(): void {
  selectedProjectIds.value = new Set();
}

/**
 * Invert current selection.
 */
function invertSelection(): void {
  const selectable = selectableProjectIds.value;
  const current = selectedProjectIds.value;
  const next = new Set<string>();
  for (const id of selectable) {
    if (!current.has(id)) {
      next.add(id);
    }
  }
  selectedProjectIds.value = next;
}

// Abort controller for ongoing requests
let statsAbort: AbortController | null = null;

interface LoadStatsOptions {
  /** Whether to reset the status message. Defaults to true. */
  resetStatusMessage?: boolean;
}

/**
 * Load attachment stats from server.
 */
async function loadStats(opts: LoadStatsOptions = {}): Promise<void> {
  const { resetStatusMessage = true } = opts;

  if (!baseUrl.value) return;

  // Abort previous request
  statsAbort?.abort();
  const controller = new AbortController();
  statsAbort = controller;

  isLoading.value = true;
  errorMessage.value = null;
  if (resetStatusMessage) {
    statusMessage.value = null;
  }

  try {
    const url = `${baseUrl.value}/agent/attachments/stats`;
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `HTTP ${response.status}`);
    }

    const data = (await response.json().catch(() => null)) as AttachmentStatsResponse | null;
    if (!data || data.success !== true) {
      throw new Error('Invalid response from server.');
    }

    stats.value = data;

    // Keep selection only for currently selectable projects (exists + has files)
    const selectableIds = new Set(data.projects.filter(isSelectable).map((p) => p.projectId));
    selectedProjectIds.value = new Set(
      [...selectedProjectIds.value].filter((id) => selectableIds.has(id)),
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'AbortError') return;
    console.error('Failed to load attachment stats:', err);
    errorMessage.value = err instanceof Error ? err.message : 'Failed to load attachment stats.';
  } finally {
    if (!controller.signal.aborted) {
      isLoading.value = false;
    }
  }
}

/**
 * Refresh stats.
 */
async function refresh(): Promise<void> {
  if (!serverReady.value) return;
  await loadStats();
}

/**
 * Clear selected projects' attachments.
 */
async function clearSelected(): Promise<void> {
  if (!baseUrl.value) return;
  const projectIds = [...selectedProjectIds.value];
  if (projectIds.length === 0) return;

  isClearing.value = true;
  errorMessage.value = null;
  statusMessage.value = null;

  try {
    const url = `${baseUrl.value}/agent/attachments`;
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectIds }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `HTTP ${response.status}`);
    }

    const result = (await response.json().catch(() => null)) as AttachmentCleanupResponse | null;
    if (!result || result.success !== true) {
      throw new Error('Invalid response from server.');
    }

    statusMessage.value = `Removed ${formatBytes(result.removedBytes)} (${result.removedFiles.toLocaleString()} files).`;
    selectedProjectIds.value = new Set();

    // Reload stats to reflect changes (preserve status message)
    await loadStats({ resetStatusMessage: false });
  } catch (err: unknown) {
    console.error('Failed to clear attachments:', err);
    errorMessage.value = err instanceof Error ? err.message : 'Failed to clear attachments.';
  } finally {
    isClearing.value = false;
  }
}

/**
 * Handle close action.
 */
function handleClose(): void {
  emit('close');
}

// Register Escape key listener when panel is open and cleanup on close
watch(
  () => props.open,
  (open, _prev, onCleanup) => {
    if (!open) {
      // Panel closed - abort any ongoing requests and reset loading state
      statsAbort?.abort();
      isLoading.value = false;
      return;
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  },
);

// Load stats when panel opens
watch(
  () => [props.open, baseUrl.value] as const,
  ([open, url]) => {
    if (!open || !url) return;
    void loadStats();
  },
  { immediate: true },
);

// Cleanup on unmount
onUnmounted(() => {
  statsAbort?.abort();
});
</script>
