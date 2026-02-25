<template>
  <div
    v-if="open"
    class="fixed top-12 left-4 right-4 z-50 py-2 max-w-[calc(100%-2rem)]"
    :style="{
      backgroundColor: 'var(--ac-surface, #ffffff)',
      border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
      borderRadius: 'var(--ac-radius-inner, 8px)',
      boxShadow: 'var(--ac-shadow-float, 0 4px 20px -2px rgba(0,0,0,0.1))',
    }"
  >
    <!-- Sessions Section -->
    <div
      class="px-3 py-1 text-[10px] font-bold uppercase tracking-wider"
      :style="{ color: 'var(--ac-text-subtle, #a8a29e)' }"
    >
      Sessions
    </div>

    <!-- Loading State -->
    <div
      v-if="isLoading"
      class="px-3 py-4 text-center text-xs"
      :style="{ color: 'var(--ac-text-muted, #6e6e6e)' }"
    >
      Loading sessions...
    </div>

    <!-- Empty State -->
    <div
      v-else-if="sessions.length === 0"
      class="px-3 py-4 text-center text-xs"
      :style="{ color: 'var(--ac-text-muted, #6e6e6e)' }"
    >
      No sessions yet
    </div>

    <!-- Session List -->
    <div v-else class="max-h-[240px] overflow-y-auto ac-scroll">
      <div v-for="session in sessions" :key="session.id" class="group relative">
        <button
          class="w-full px-3 py-2 text-left text-sm flex items-center justify-between ac-menu-item"
          :style="{
            color:
              selectedSessionId === session.id
                ? 'var(--ac-accent, #c87941)'
                : 'var(--ac-text, #1a1a1a)',
          }"
          @click="handleSessionSelect(session.id)"
        >
          <div class="flex-1 min-w-0 pr-16">
            <!-- Session Name (inline editing) -->
            <div class="truncate flex items-center gap-2">
              <template v-if="editingSessionId === session.id">
                <input
                  ref="renameInputRef"
                  v-model="editingName"
                  type="text"
                  class="w-full px-1 py-0.5 text-sm"
                  :style="{
                    backgroundColor: 'var(--ac-surface, #ffffff)',
                    border: 'var(--ac-border-width, 1px) solid var(--ac-accent, #c87941)',
                    borderRadius: 'var(--ac-radius-button, 8px)',
                    color: 'var(--ac-text, #1a1a1a)',
                    outline: 'none',
                  }"
                  @click.stop
                  @keydown.enter="confirmRename(session.id)"
                  @keydown.escape="cancelRename"
                  @blur="confirmRename(session.id)"
                />
              </template>
              <template v-else>
                <span>{{ getSessionDisplayName(session) }}</span>
                <span
                  class="text-[10px] px-1.5 py-0.5"
                  :style="{
                    backgroundColor: getEngineColor(session.engineName),
                    color: '#ffffff',
                    borderRadius: 'var(--ac-radius-button, 8px)',
                  }"
                >
                  {{ session.engineName }}
                </span>
              </template>
            </div>
            <!-- Session Info -->
            <div
              class="text-[10px] truncate flex items-center gap-2"
              :style="{
                fontFamily: 'var(--ac-font-mono, monospace)',
                color: 'var(--ac-text-subtle, #a8a29e)',
              }"
            >
              <span v-if="session.model">{{ session.model }}</span>
              <span>{{ formatDate(session.updatedAt) }}</span>
            </div>
          </div>

          <!-- Action Buttons (shown on hover) -->
          <div
            class="absolute right-8 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <!-- Rename Button -->
            <button
              v-if="editingSessionId !== session.id"
              class="p-1 ac-btn cursor-pointer"
              :style="{
                color: 'var(--ac-text-muted, #6e6e6e)',
                borderRadius: 'var(--ac-radius-button)',
              }"
              title="Rename session"
              @click.stop="startRename(session)"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                />
              </svg>
            </button>
            <!-- Delete Button -->
            <button
              class="p-1 ac-btn cursor-pointer"
              :style="{
                color: 'var(--ac-danger, #dc2626)',
                borderRadius: 'var(--ac-radius-button)',
              }"
              title="Delete session"
              @click.stop="handleDeleteSession(session.id)"
            >
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </button>
          </div>

          <!-- Selected Check -->
          <svg
            v-if="selectedSessionId === session.id"
            class="w-4 h-4 flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M5 13l4 4L19 7"
            />
          </svg>
        </button>
      </div>
    </div>

    <!-- New Session Button -->
    <button
      class="w-full px-3 py-2 text-left text-sm ac-menu-item"
      :style="{ color: 'var(--ac-link, #3b82f6)' }"
      :disabled="isCreating"
      @click="handleNewSession"
    >
      {{ isCreating ? 'Creating...' : '+ New Session' }}
    </button>

    <!-- Error -->
    <div v-if="error" class="px-3 py-1 text-[10px]" :style="{ color: 'var(--ac-danger, #dc2626)' }">
      {{ error }}
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, nextTick } from 'vue';
import type { AgentSession } from 'webpage-mcp-shared';

const props = defineProps<{
  open: boolean;
  sessions: AgentSession[];
  selectedSessionId: string;
  isLoading: boolean;
  isCreating: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  'session:select': [sessionId: string];
  'session:new': [];
  'session:delete': [sessionId: string];
  'session:rename': [sessionId: string, name: string];
}>();

// Inline rename state
const editingSessionId = ref<string | null>(null);
const editingName = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);

function getEngineColor(engineName: string): string {
  const colors: Record<string, string> = {
    claude: '#c87941',
    codex: '#10a37f',
    cursor: '#8b5cf6',
    qwen: '#6366f1',
    glm: '#ef4444',
  };
  return colors[engineName] || '#6b7280';
}

/**
 * Get display name for a session.
 * Priority: preview (first user message) > name > 'Unnamed Session'
 */
function getSessionDisplayName(session: AgentSession): string {
  // Use preview if available (first user message)
  if (session.preview) {
    return session.preview;
  }
  // Fall back to session name
  if (session.name) {
    return session.name;
  }
  return 'Unnamed Session';
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function handleSessionSelect(sessionId: string): void {
  // Don't select if we're editing
  if (editingSessionId.value) return;
  emit('session:select', sessionId);
}

function handleNewSession(): void {
  emit('session:new');
}

function handleDeleteSession(sessionId: string): void {
  if (confirm('Delete this session? This cannot be undone.')) {
    emit('session:delete', sessionId);
  }
}

// Inline rename handlers
function startRename(session: AgentSession): void {
  editingSessionId.value = session.id;
  editingName.value = session.name || '';
  nextTick(() => {
    renameInputRef.value?.focus();
    renameInputRef.value?.select();
  });
}

function confirmRename(sessionId: string): void {
  const trimmedName = editingName.value.trim();
  if (trimmedName && editingSessionId.value === sessionId) {
    emit('session:rename', sessionId, trimmedName);
  }
  cancelRename();
}

function cancelRename(): void {
  editingSessionId.value = null;
  editingName.value = '';
}
</script>
