<template>
  <Teleport :to="teleportTarget" :disabled="!teleportTarget">
    <Transition name="composer-drawer">
      <div
        v-if="open"
        class="fixed inset-0 z-50"
        role="dialog"
        aria-modal="true"
        aria-label="Expanded editor"
        @keydown.esc="emit('close')"
      >
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-black/40 composer-drawer-backdrop" @click="emit('close')" />

        <!-- Sheet -->
        <div
          class="absolute inset-x-0 bottom-0 composer-drawer-sheet overflow-hidden flex flex-col"
          :style="sheetStyle"
          @click.stop
        >
          <!-- Header -->
          <div class="flex items-center justify-between px-4 py-3" :style="headerStyle">
            <div class="min-w-0">
              <div class="text-sm font-semibold" :style="{ color: 'var(--ac-text)' }">
                Expanded editor
              </div>
              <div class="text-[10px]" :style="{ color: 'var(--ac-text-subtle)' }">
                Press {{ modifierKey }}+Enter to send
              </div>
            </div>

            <button
              type="button"
              class="p-1.5 transition-colors hover:opacity-80 cursor-pointer"
              :style="closeButtonStyle"
              aria-label="Close expanded editor"
              @click="emit('close')"
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

          <!-- Content -->
          <div class="flex-1 min-h-0 overflow-hidden flex flex-col px-4 py-3 gap-3">
            <!-- Attachment previews -->
            <div v-if="attachments.length > 0" class="flex flex-wrap gap-2">
              <div v-for="(attachment, index) in attachments" :key="index" class="relative group">
                <div class="w-14 h-14 rounded-lg overflow-hidden" :style="thumbnailStyle">
                  <img
                    v-if="attachment.type === 'image' && attachment.previewUrl"
                    :src="attachment.previewUrl"
                    :alt="attachment.name"
                    class="w-full h-full object-cover"
                  />
                  <div
                    v-else
                    class="w-full h-full flex items-center justify-center"
                    :style="{ color: 'var(--ac-text-subtle)' }"
                  >
                    <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                </div>

                <!-- Remove button -->
                <button
                  class="absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  :style="removeButtonStyle"
                  title="Remove image"
                  @click="emit('attachment:remove', index)"
                >
                  <svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="3"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>

                <!-- Filename overlay -->
                <div
                  class="absolute bottom-0 left-0 right-0 px-0.5 py-0.5 text-[8px] truncate opacity-0 group-hover:opacity-100 transition-opacity rounded-b-lg"
                  :style="filenameOverlayStyle"
                >
                  {{ attachment.name }}
                </div>
              </div>
            </div>

            <!-- Attachment error -->
            <div v-if="attachmentError" class="text-xs" :style="{ color: 'var(--ac-error)' }">
              {{ attachmentError }}
            </div>

            <!-- Expanded textarea with fake caret -->
            <div class="relative flex-1 min-h-0 flex flex-col">
              <textarea
                ref="textareaRef"
                :value="modelValue"
                class="w-full flex-1 min-h-0 bg-transparent border-none focus:ring-0 focus:outline-none resize-none p-3 text-sm"
                :style="textareaStyle"
                :placeholder="placeholder"
                @input="handleInput"
                @keydown.enter.meta.exact.prevent="handleModifierEnter"
                @keydown.enter.ctrl.exact.prevent="handleModifierEnter"
                @paste="handlePaste"
              />

              <!-- Fake caret overlay (opt-in comet effect, only mount when enabled) -->
              <FakeCaretOverlay
                v-if="enableFakeCaret"
                :textarea-ref="textareaRef"
                :enabled="true"
                :value="modelValue"
              />
            </div>

            <!-- Footer actions -->
            <div class="flex items-center justify-between">
              <slot name="left-actions" />

              <div class="flex gap-2">
                <!-- Cancel button: Show when request is active (not just streaming) -->
                <button
                  v-if="isRequestActive && canCancel && !sending"
                  class="px-3 py-1.5 text-xs transition-colors cursor-pointer"
                  :style="cancelButtonStyle"
                  :disabled="cancelling"
                  @click="emit('cancel')"
                >
                  {{ cancelling ? 'Stopping...' : 'Stop' }}
                </button>

                <!-- Send button -->
                <button
                  class="px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer"
                  :style="sendButtonStyle"
                  :disabled="!canSend || sending"
                  @click="handleSubmit"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script lang="ts" setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import type { AttachmentWithPreview } from '../../composables/useAttachments';
import type { RequestState } from '../../composables/useAgentChat';
import FakeCaretOverlay from './FakeCaretOverlay.vue';

const props = defineProps<{
  /** Whether the drawer is open */
  open: boolean;
  /** Current input value */
  modelValue: string;
  /** Placeholder text */
  placeholder?: string;
  /** Attachments list */
  attachments: AttachmentWithPreview[];
  /** Attachment error message */
  attachmentError?: string | null;
  /** Request lifecycle state (starting/running/completed/cancelled) */
  requestState: RequestState;
  /** Whether message is being sent */
  sending: boolean;
  /** Whether cancel is in progress */
  cancelling: boolean;
  /** Whether cancel is available */
  canCancel: boolean;
  /** Whether send is available */
  canSend: boolean;
  /** Fake caret feature flag */
  enableFakeCaret?: boolean;
}>();

/**
 * Whether there is an active request in progress.
 * Derived from requestState for use in UI conditions.
 */
const isRequestActive = computed(() => {
  return (
    props.requestState === 'starting' ||
    props.requestState === 'ready' ||
    props.requestState === 'running'
  );
});

const emit = defineEmits<{
  close: [];
  'update:modelValue': [value: string];
  submit: [];
  cancel: [];
  'attachment:remove': [index: number];
  paste: [event: ClipboardEvent];
}>();

const textareaRef = ref<HTMLTextAreaElement | null>(null);
const teleportTarget = ref<Element | null>(null);

// Detect OS for keyboard shortcut display
const modifierKey = computed(() => {
  if (typeof navigator === 'undefined') return 'Ctrl';
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
});

// Styles
const sheetStyle = computed(() => ({
  height: '65vh',
  backgroundColor: 'var(--ac-surface)',
  borderTop: 'var(--ac-border-width) solid var(--ac-border)',
  borderTopLeftRadius: 'var(--ac-radius-card)',
  borderTopRightRadius: 'var(--ac-radius-card)',
  boxShadow: 'var(--ac-shadow-float)',
}));

const headerStyle = computed(() => ({
  borderBottom: 'var(--ac-border-width) solid var(--ac-border)',
}));

const closeButtonStyle = computed(() => ({
  backgroundColor: 'transparent',
  color: 'var(--ac-text-muted)',
  borderRadius: 'var(--ac-radius-button)',
}));

const thumbnailStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  border: 'var(--ac-border-width) solid var(--ac-border)',
}));

const removeButtonStyle = computed(() => ({
  backgroundColor: 'var(--ac-error)',
  color: 'white',
}));

const filenameOverlayStyle = computed(() => ({
  backgroundColor: 'rgba(0,0,0,0.6)',
  color: 'white',
}));

const textareaStyle = computed(() => ({
  fontFamily: 'var(--ac-font-body)',
  color: 'var(--ac-text)',
  backgroundColor: 'var(--ac-surface-muted)',
  border: 'var(--ac-border-width) solid var(--ac-border)',
  borderRadius: 'var(--ac-radius-card)',
}));

const cancelButtonStyle = computed(() => ({
  backgroundColor: 'var(--ac-hover-bg)',
  color: 'var(--ac-text)',
  borderRadius: 'var(--ac-radius-button)',
}));

const sendButtonStyle = computed(() => ({
  backgroundColor: props.canSend ? 'var(--ac-accent)' : 'var(--ac-surface-muted)',
  color: props.canSend ? 'var(--ac-accent-contrast)' : 'var(--ac-text-subtle)',
  borderRadius: 'var(--ac-radius-button)',
  cursor: props.canSend ? 'pointer' : 'not-allowed',
}));

// Event handlers
function handleInput(event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value;
  emit('update:modelValue', value);
}

function handleModifierEnter(): void {
  if (props.canSend && !props.sending) {
    emit('submit');
  }
}

function handleSubmit(): void {
  emit('submit');
}

function handlePaste(event: ClipboardEvent): void {
  emit('paste', event);
}

// Escape key handler for document-level capture (handles cases where focus is elsewhere)
function handleEscapeKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    emit('close');
  }
}

// Focus textarea when drawer opens, and setup/cleanup Escape key listener
watch(
  () => props.open,
  async (isOpen, _prevOpen, onCleanup) => {
    if (isOpen) {
      await nextTick();
      textareaRef.value?.focus();

      // Add document-level Escape listener
      document.addEventListener('keydown', handleEscapeKey);
      onCleanup(() => {
        document.removeEventListener('keydown', handleEscapeKey);
      });
    }
  },
);

// Find teleport target - search from a root element to find .agent-theme ancestor
// This is more robust than document.querySelector for multi-instance scenarios
const rootRef = ref<HTMLElement | null>(null);

onMounted(() => {
  // Create a temporary element to measure from (since drawer content is teleported)
  // We find .agent-theme from the current document context
  const agentTheme = document.querySelector('.agent-theme');
  teleportTarget.value = agentTheme ?? document.body;
});

// Expose focus method
defineExpose({
  focus: () => textareaRef.value?.focus(),
});
</script>

<style scoped>
/* Drawer transition */
.composer-drawer-enter-active,
.composer-drawer-leave-active {
  transition: opacity 0.16s ease;
}

.composer-drawer-enter-active .composer-drawer-backdrop,
.composer-drawer-leave-active .composer-drawer-backdrop {
  transition: opacity 0.16s ease;
}

.composer-drawer-enter-active .composer-drawer-sheet,
.composer-drawer-leave-active .composer-drawer-sheet {
  transition: transform 0.2s cubic-bezier(0.32, 0.72, 0, 1);
}

.composer-drawer-enter-from,
.composer-drawer-leave-to {
  opacity: 0;
}

.composer-drawer-enter-from .composer-drawer-sheet,
.composer-drawer-leave-to .composer-drawer-sheet {
  transform: translateY(100%);
}
</style>
