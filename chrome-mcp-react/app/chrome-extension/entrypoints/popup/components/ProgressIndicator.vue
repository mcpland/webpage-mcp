<template>
  <div v-if="visible" class="progress-section">
    <div class="progress-indicator">
      <div class="spinner" v-if="showSpinner"></div>
      <span class="progress-text">{{ text }}</span>
    </div>
  </div>
</template>

<script lang="ts" setup>
interface Props {
  visible?: boolean;
  text: string;
  showSpinner?: boolean;
}

withDefaults(defineProps<Props>(), {
  visible: true,
  showSpinner: true,
});
</script>

<style scoped>
.progress-section {
  margin-top: 16px;
  animation: slideIn 0.3s ease-out;
}

.progress-indicator {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: linear-gradient(135deg, rgba(102, 126, 234, 0.1), rgba(118, 75, 162, 0.1));
  border-radius: 8px;
  border-left: 4px solid #667eea;
  backdrop-filter: blur(10px);
  border: 1px solid rgba(102, 126, 234, 0.2);
}

.spinner {
  width: 20px;
  height: 20px;
  border: 3px solid rgba(102, 126, 234, 0.2);
  border-top: 3px solid #667eea;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.progress-text {
  font-size: 14px;
  color: #4a5568;
  font-weight: 500;
  line-height: 1.4;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 响应式设计 */
@media (max-width: 420px) {
  .progress-indicator {
    padding: 12px;
    gap: 8px;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border-width: 2px;
  }

  .progress-text {
    font-size: 13px;
  }
}
</style>
