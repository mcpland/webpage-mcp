<template>
  <ReactComponentHost :component="AgentComposerReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { CodexReasoningEffort } from 'webpage-mcp-shared';
import type { ModelDefinition } from '@/common/agent-models';
import type { AttachmentWithPreview } from '../../composables/useAttachments';
import type { RequestState } from '../../composables/useAgentChat';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import AgentComposerReact from './AgentComposer';

const props = defineProps<{
  modelValue: string;
  attachments: AttachmentWithPreview[];
  attachmentError?: string | null;
  isDragOver?: boolean;
  isStreaming: boolean;
  requestState: RequestState;
  sending: boolean;
  cancelling: boolean;
  canCancel: boolean;
  canSend: boolean;
  placeholder?: string;
  engineName?: string;
  selectedModel: string;
  availableModels: ModelDefinition[];
  reasoningEffort?: CodexReasoningEffort;
  availableReasoningEfforts?: readonly CodexReasoningEffort[];
  enableFakeCaret?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
  submit: [];
  cancel: [];
  'attachment:add': [];
  'attachment:remove': [index: number];
  'attachment:drop': [event: DragEvent];
  'attachment:paste': [event: ClipboardEvent];
  'attachment:dragover': [event: DragEvent];
  'attachment:dragleave': [event: DragEvent];
  'model:change': [modelId: string];
  'reasoning-effort:change': [effort: CodexReasoningEffort];
  'session:settings': [];
  'session:reset': [];
}>();

const componentProps = computed(() => ({
  modelValue: props.modelValue,
  attachments: props.attachments,
  attachmentError: props.attachmentError,
  isDragOver: props.isDragOver,
  isStreaming: props.isStreaming,
  requestState: props.requestState,
  sending: props.sending,
  cancelling: props.cancelling,
  canCancel: props.canCancel,
  canSend: props.canSend,
  placeholder: props.placeholder,
  engineName: props.engineName,
  selectedModel: props.selectedModel,
  availableModels: props.availableModels,
  reasoningEffort: props.reasoningEffort,
  availableReasoningEfforts: props.availableReasoningEfforts,
  enableFakeCaret: props.enableFakeCaret,
  onUpdateModelValue: (value: string) => emit('update:modelValue', value),
  onSubmit: () => emit('submit'),
  onCancel: () => emit('cancel'),
  onAttachmentAdd: () => emit('attachment:add'),
  onAttachmentRemove: (index: number) => emit('attachment:remove', index),
  onAttachmentDrop: (event: DragEvent) => emit('attachment:drop', event),
  onAttachmentPaste: (event: ClipboardEvent) => emit('attachment:paste', event),
  onAttachmentDragOver: (event: DragEvent) => emit('attachment:dragover', event),
  onAttachmentDragLeave: (event: DragEvent) => emit('attachment:dragleave', event),
  onModelChange: (modelId: string) => emit('model:change', modelId),
  onReasoningEffortChange: (effort: CodexReasoningEffort) => emit('reasoning-effort:change', effort),
  onSessionSettings: () => emit('session:settings'),
  onSessionReset: () => emit('session:reset'),
}));
</script>
