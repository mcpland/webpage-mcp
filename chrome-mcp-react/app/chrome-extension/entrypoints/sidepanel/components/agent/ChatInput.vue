<template>
  <form class="p-3 border-t border-slate-200 bg-white space-y-2" @submit.prevent="handleSubmit">
    <!-- Attachments preview -->
    <AttachmentPreview
      v-if="attachments.length > 0"
      :attachments="attachments"
      @remove="$emit('remove-attachment', $event)"
    />

    <textarea
      v-model="inputValue"
      class="w-full border border-slate-200 rounded-md px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-slate-400"
      rows="2"
      placeholder="Ask the agent to work with your browser via MCP..."
      @input="$emit('update:modelValue', inputValue)"
    ></textarea>

    <!-- Hidden file input -->
    <input
      ref="fileInputRef"
      type="file"
      class="hidden"
      accept="image/*"
      multiple
      @change="$emit('file-select', $event)"
    />

    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="text-slate-500 hover:text-slate-700 text-xs px-2 py-1 border border-slate-200 rounded hover:bg-slate-50"
          title="Attach images"
          @click="openFilePicker"
        >
          Attach
        </button>
        <div class="text-[11px] text-slate-500">
          {{ isStreaming ? 'Agent is thinking...' : 'Ready' }}
        </div>
      </div>
      <div class="flex gap-2">
        <button
          v-if="isStreaming && canCancel"
          type="button"
          class="btn-secondary !px-3 !py-2 text-xs"
          :disabled="cancelling"
          @click="$emit('cancel')"
        >
          {{ cancelling ? 'Cancelling...' : 'Stop' }}
        </button>
        <button
          type="submit"
          class="btn-primary !px-4 !py-2 text-xs"
          :disabled="!canSend || sending"
        >
          {{ sending ? 'Sending...' : 'Send' }}
        </button>
      </div>
    </div>
  </form>
</template>

<script lang="ts" setup>
import { ref, watch } from 'vue';
import type { AgentAttachment } from 'webpage-mcp-shared';
import AttachmentPreview from './AttachmentPreview.vue';

const props = defineProps<{
  modelValue: string;
  attachments: AgentAttachment[];
  isStreaming: boolean;
  sending: boolean;
  cancelling: boolean;
  canCancel: boolean;
  canSend: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  submit: [];
  cancel: [];
  'file-select': [event: Event];
  'remove-attachment': [index: number];
}>();

const inputValue = ref(props.modelValue);
const fileInputRef = ref<HTMLInputElement | null>(null);

// Sync with parent
watch(
  () => props.modelValue,
  (newVal) => {
    inputValue.value = newVal;
  },
);

function openFilePicker(): void {
  fileInputRef.value?.click();
}

function handleSubmit(): void {
  emit('submit');
}

// Expose file input ref for parent
defineExpose({
  fileInputRef,
});
</script>
