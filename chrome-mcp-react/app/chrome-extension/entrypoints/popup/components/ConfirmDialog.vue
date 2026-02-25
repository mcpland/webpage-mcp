<template>
  <div v-if="visible" class="confirmation-dialog" @click.self="$emit('cancel')">
    <div class="dialog-content">
      <div class="dialog-header">
        <span class="dialog-icon">{{ icon }}</span>
        <h3 class="dialog-title">{{ title }}</h3>
      </div>

      <div class="dialog-body">
        <p class="dialog-message">{{ message }}</p>

        <ul v-if="items && items.length > 0" class="dialog-list">
          <li v-for="item in items" :key="item">{{ item }}</li>
        </ul>

        <div v-if="warning" class="dialog-warning">
          <strong>{{ warning }}</strong>
        </div>
      </div>

      <div class="dialog-actions">
        <button class="dialog-button cancel-button" @click="$emit('cancel')">
          {{ cancelText }}
        </button>
        <button
          class="dialog-button confirm-button"
          :disabled="isConfirming"
          @click="$emit('confirm')"
        >
          {{ isConfirming ? confirmingText : confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { getMessage } from '@/utils/i18n';
interface Props {
  visible: boolean;
  title: string;
  message: string;
  items?: string[];
  warning?: string;
  icon?: string;
  confirmText?: string;
  cancelText?: string;
  confirmingText?: string;
  isConfirming?: boolean;
}

interface Emits {
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}

withDefaults(defineProps<Props>(), {
  icon: '⚠️',
  confirmText: getMessage('confirmButton'),
  cancelText: getMessage('cancelButton'),
  confirmingText: getMessage('processingStatus'),
  isConfirming: false,
});

defineEmits<Emits>();
</script>

<style scoped>
.confirmation-dialog {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(8px);
  animation: dialogFadeIn 0.3s ease-out;
}

@keyframes dialogFadeIn {
  from {
    opacity: 0;
    backdrop-filter: blur(0px);
  }
  to {
    opacity: 1;
    backdrop-filter: blur(8px);
  }
}

.dialog-content {
  background: white;
  border-radius: 12px;
  padding: 24px;
  max-width: 360px;
  width: 90%;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  animation: dialogSlideIn 0.3s ease-out;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

@keyframes dialogSlideIn {
  from {
    opacity: 0;
    transform: translateY(-30px) scale(0.9);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.dialog-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}

.dialog-icon {
  font-size: 24px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1));
}

.dialog-title {
  font-size: 18px;
  font-weight: 600;
  color: #2d3748;
  margin: 0;
}

.dialog-body {
  margin-bottom: 24px;
}

.dialog-message {
  font-size: 14px;
  color: #4a5568;
  margin: 0 0 16px 0;
  line-height: 1.6;
}

.dialog-list {
  margin: 16px 0;
  padding-left: 24px;
  background: linear-gradient(135deg, #f7fafc, #edf2f7);
  border-radius: 6px;
  padding: 12px 12px 12px 32px;
  border-left: 3px solid #667eea;
}

.dialog-list li {
  font-size: 13px;
  color: #718096;
  margin-bottom: 6px;
  line-height: 1.4;
}

.dialog-list li:last-child {
  margin-bottom: 0;
}

.dialog-warning {
  font-size: 13px;
  color: #e53e3e;
  margin: 16px 0 0 0;
  padding: 12px;
  background: linear-gradient(135deg, rgba(245, 101, 101, 0.1), rgba(229, 62, 62, 0.05));
  border-radius: 6px;
  border-left: 3px solid #e53e3e;
  border: 1px solid rgba(245, 101, 101, 0.2);
}

.dialog-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.dialog-button {
  padding: 10px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.3s ease;
  min-width: 80px;
}

.cancel-button {
  background: linear-gradient(135deg, #e2e8f0, #cbd5e0);
  color: #4a5568;
  border: 1px solid #cbd5e0;
}

.cancel-button:hover {
  background: linear-gradient(135deg, #cbd5e0, #a0aec0);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(160, 174, 192, 0.3);
}

.confirm-button {
  background: linear-gradient(135deg, #f56565, #e53e3e);
  color: white;
  border: 1px solid #e53e3e;
}

.confirm-button:hover:not(:disabled) {
  background: linear-gradient(135deg, #e53e3e, #c53030);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(245, 101, 101, 0.4);
}

.confirm-button:disabled {
  opacity: 0.7;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

/* 响应式设计 */
@media (max-width: 420px) {
  .dialog-content {
    padding: 20px;
    max-width: 320px;
  }

  .dialog-header {
    gap: 10px;
    margin-bottom: 16px;
  }

  .dialog-icon {
    font-size: 20px;
  }

  .dialog-title {
    font-size: 16px;
  }

  .dialog-message {
    font-size: 13px;
  }

  .dialog-list {
    padding: 10px 10px 10px 28px;
  }

  .dialog-list li {
    font-size: 12px;
  }

  .dialog-warning {
    font-size: 12px;
    padding: 10px;
  }

  .dialog-actions {
    gap: 8px;
    flex-direction: column-reverse;
  }

  .dialog-button {
    width: 100%;
    padding: 12px 16px;
  }
}

/* 焦点样式 */
.dialog-button:focus {
  outline: none;
  box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.3);
}

.cancel-button:focus {
  box-shadow: 0 0 0 3px rgba(160, 174, 192, 0.3);
}

.confirm-button:focus {
  box-shadow: 0 0 0 3px rgba(245, 101, 101, 0.3);
}
</style>
