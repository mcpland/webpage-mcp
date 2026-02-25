<template>
  <div
    class="workflow-item"
    :style="itemStyle"
    @mouseenter="showActions = true"
    @mouseleave="showActions = false"
  >
    <div class="workflow-content">
      <!-- Title and description -->
      <div class="workflow-info">
        <div class="workflow-name" :style="nameStyle">{{ flow.name || 'Untitled' }}</div>
        <div class="workflow-desc" :style="descStyle">{{
          flow.description || 'No description'
        }}</div>
        <!-- Tags -->
        <div v-if="hasTags" class="workflow-tags">
          <span v-if="flow.meta?.domain" class="workflow-tag" :style="tagDomainStyle">
            {{ flow.meta.domain }}
          </span>
          <span
            v-for="tag in flow.meta?.tags || []"
            :key="tag"
            class="workflow-tag"
            :style="tagStyle"
          >
            {{ tag }}
          </span>
        </div>
      </div>

      <!-- Actions -->
      <div class="workflow-actions" :class="{ 'workflow-actions-visible': showActions }">
        <button
          class="workflow-action workflow-action-primary"
          :style="actionPrimaryStyle"
          @click.stop="$emit('run', flow.id)"
          title="Run workflow"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
        <button
          class="workflow-action"
          :style="actionStyle"
          @click.stop="$emit('edit', flow.id)"
          title="Edit workflow"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
            />
          </svg>
        </button>
        <button
          class="workflow-action workflow-action-more"
          :style="actionStyle"
          @click.stop="toggleMoreMenu"
          title="More actions"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <circle cx="12" cy="5" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="12" cy="19" r="2" />
          </svg>
        </button>

        <!-- More menu dropdown -->
        <Transition name="menu-fade">
          <div v-if="showMoreMenu" class="workflow-more-menu" :style="menuStyle" @click.stop>
            <button class="workflow-menu-item" :style="menuItemStyle" @click="handleExport">
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              </svg>
              <span>Export</span>
            </button>
            <button
              class="workflow-menu-item workflow-menu-item-danger"
              :style="menuItemDangerStyle"
              @click="handleDelete"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
              <span>Delete</span>
            </button>
          </div>
        </Transition>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';

interface FlowLite {
  id: string;
  name: string;
  description?: string;
  meta?: {
    domain?: string;
    tags?: string[];
    bindings?: any[];
  };
}

const props = defineProps<{
  flow: FlowLite;
}>();

const emit = defineEmits<{
  (e: 'run', id: string): void;
  (e: 'edit', id: string): void;
  (e: 'delete', id: string): void;
  (e: 'export', id: string): void;
}>();

const showActions = ref(false);
const showMoreMenu = ref(false);

const hasTags = computed(() => {
  return props.flow.meta?.domain || (props.flow.meta?.tags?.length ?? 0) > 0;
});

// Close menu when clicking outside
function handleClickOutside(e: MouseEvent) {
  if (showMoreMenu.value) {
    showMoreMenu.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
});

function toggleMoreMenu() {
  showMoreMenu.value = !showMoreMenu.value;
}

function handleDelete() {
  showMoreMenu.value = false;
  emit('delete', props.flow.id);
}

function handleExport() {
  showMoreMenu.value = false;
  emit('export', props.flow.id);
}

// Computed styles using CSS variables
const itemStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface)',
  borderRadius: 'var(--ac-radius-card, 12px)',
  border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4)',
  transition: 'all var(--ac-motion-fast, 120ms) ease',
}));

const nameStyle = computed(() => ({
  color: 'var(--ac-text, #1a1a1a)',
}));

const descStyle = computed(() => ({
  color: 'var(--ac-text-muted, #6e6e6e)',
}));

const tagDomainStyle = computed(() => ({
  backgroundColor: 'var(--ac-accent-subtle, rgba(217, 119, 87, 0.12))',
  color: 'var(--ac-accent, #d97757)',
}));

const tagStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted, #f2f0eb)',
  color: 'var(--ac-text-muted, #6e6e6e)',
}));

const actionStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted, #f2f0eb)',
  color: 'var(--ac-text-muted, #6e6e6e)',
  borderRadius: 'var(--ac-radius-button, 8px)',
}));

const actionPrimaryStyle = computed(() => ({
  backgroundColor: 'var(--ac-accent, #d97757)',
  color: 'var(--ac-accent-contrast, #ffffff)',
  borderRadius: 'var(--ac-radius-button, 8px)',
}));

const menuStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface, #ffffff)',
  border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e7e5e4)',
  borderRadius: 'var(--ac-radius-inner, 8px)',
  boxShadow: 'var(--ac-shadow-float, 0 4px 20px -2px rgba(0, 0, 0, 0.1))',
}));

const menuItemStyle = computed(() => ({
  color: 'var(--ac-text, #1a1a1a)',
}));

const menuItemDangerStyle = computed(() => ({
  color: 'var(--ac-danger, #ef4444)',
}));
</script>

<style scoped>
.workflow-item {
  padding: 16px;
  cursor: pointer;
}

.workflow-item:hover {
  background-color: var(--ac-hover-bg, #f5f5f4) !important;
  box-shadow: var(--ac-shadow-card, 0 1px 3px rgba(0, 0, 0, 0.08));
}

.workflow-content {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.workflow-info {
  flex: 1;
  min-width: 0;
}

.workflow-name {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  margin-bottom: 2px;
  word-break: break-word;
}

.workflow-desc {
  font-size: 13px;
  line-height: 1.4;
  margin-bottom: 8px;
  word-break: break-word;
}

.workflow-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.workflow-tag {
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 4px;
  white-space: nowrap;
}

.workflow-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0;
  transition: opacity var(--ac-motion-fast, 120ms) ease;
  position: relative;
}

.workflow-actions-visible {
  opacity: 1;
}

.workflow-action {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  cursor: pointer;
  transition: all var(--ac-motion-fast, 120ms) ease;
}

.workflow-action:hover {
  transform: translateY(-1px);
  box-shadow: var(--ac-shadow-float, 0 4px 20px -2px rgba(0, 0, 0, 0.05));
}

.workflow-action-primary:hover {
  background-color: var(--ac-accent-hover, #c4664a) !important;
}

.workflow-more-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 140px;
  padding: 4px;
  z-index: 100;
}

.workflow-menu-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  background: transparent;
  border: none;
  border-radius: var(--ac-radius-button, 8px);
  cursor: pointer;
  transition: background-color var(--ac-motion-fast, 120ms) ease;
  text-align: left;
}

.workflow-menu-item:hover {
  background-color: var(--ac-hover-bg, #f5f5f4);
}

.workflow-menu-item-danger:hover {
  background-color: rgba(239, 68, 68, 0.1);
}

/* Menu fade transition */
.menu-fade-enter-active,
.menu-fade-leave-active {
  transition:
    opacity var(--ac-motion-fast, 120ms) ease,
    transform var(--ac-motion-fast, 120ms) ease;
}

.menu-fade-enter-from,
.menu-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
