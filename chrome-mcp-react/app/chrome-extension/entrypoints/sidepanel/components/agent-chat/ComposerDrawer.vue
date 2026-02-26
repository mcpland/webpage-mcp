<template>
  <ReactComponentHost :component="ComposerDrawerReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { AttachmentWithPreview } from '../../composables/useAttachments';
import type { RequestState } from '../../composables/useAgentChat';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import ComposerDrawerReact from './ComposerDrawer';

const props = defineProps<{
  open: boolean;
  modelValue: string;
  placeholder?: string;
  attachments: AttachmentWithPreview[];
  attachmentError?: string | null;
  requestState: RequestState;
  sending: boolean;
  cancelling: boolean;
  canCancel: boolean;
  canSend: boolean;
  enableFakeCaret?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  'update:modelValue': [value: string];
  submit: [];
  cancel: [];
  'attachment:remove': [index: number];
  paste: [event: ClipboardEvent];
}>();

const componentProps = computed(() => ({
  open: props.open,
  modelValue: props.modelValue,
  placeholder: props.placeholder,
  attachments: props.attachments,
  attachmentError: props.attachmentError,
  requestState: props.requestState,
  sending: props.sending,
  cancelling: props.cancelling,
  canCancel: props.canCancel,
  canSend: props.canSend,
  enableFakeCaret: props.enableFakeCaret,
  onClose: () => emit('close'),
  onUpdateModelValue: (value: string) => emit('update:modelValue', value),
  onSubmit: () => emit('submit'),
  onCancel: () => emit('cancel'),
  onAttachmentRemove: (index: number) => emit('attachment:remove', index),
  onPaste: (event: ClipboardEvent) => emit('paste', event),
}));
</script>
