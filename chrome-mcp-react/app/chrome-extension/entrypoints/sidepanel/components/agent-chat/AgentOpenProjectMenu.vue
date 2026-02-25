<template>
  <div
    v-if="open"
    class="fixed top-12 right-4 z-50 min-w-[160px] py-2"
    :style="{
      backgroundColor: 'var(--ac-surface, #ffffff)',
      border: 'var(--ac-border-width, 1px) solid var(--ac-border, #e5e5e5)',
      borderRadius: 'var(--ac-radius-inner, 8px)',
      boxShadow: 'var(--ac-shadow-float, 0 4px 20px -2px rgba(0,0,0,0.1))',
    }"
  >
    <!-- Header -->
    <div
      class="px-3 py-1 text-[10px] font-bold uppercase tracking-wider"
      :style="{ color: 'var(--ac-text-subtle, #a8a29e)' }"
    >
      Open In
    </div>

    <!-- VS Code Option -->
    <button
      class="w-full px-3 py-2 text-left text-sm flex items-center gap-2 ac-menu-item"
      :style="{
        color: defaultTarget === 'vscode' ? 'var(--ac-accent, #c87941)' : 'var(--ac-text, #1a1a1a)',
      }"
      @click="handleSelect('vscode')"
    >
      <!-- VS Code Icon -->
      <svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
        <path
          d="M17.583 2L6.167 11.667 2 8.5v7l4.167-3.167L17.583 22 22 19.75V4.25L17.583 2zm0 3.5v13l-8-6.5 8-6.5z"
        />
      </svg>
      <span class="flex-1">VS Code</span>
      <!-- Default indicator -->
      <svg
        v-if="defaultTarget === 'vscode'"
        class="w-4 h-4 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
      </svg>
    </button>

    <!-- Terminal Option -->
    <button
      class="w-full px-3 py-2 text-left text-sm flex items-center gap-2 ac-menu-item"
      :style="{
        color:
          defaultTarget === 'terminal' ? 'var(--ac-accent, #c87941)' : 'var(--ac-text, #1a1a1a)',
      }"
      @click="handleSelect('terminal')"
    >
      <!-- Terminal Icon -->
      <svg
        class="w-4 h-4 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        stroke-width="2"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
      </svg>
      <span class="flex-1">Terminal</span>
      <!-- Default indicator -->
      <svg
        v-if="defaultTarget === 'terminal'"
        class="w-4 h-4 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
      </svg>
    </button>
  </div>
</template>

<script lang="ts" setup>
import type { OpenProjectTarget } from 'webpage-mcp-shared';

defineProps<{
  open: boolean;
  defaultTarget: OpenProjectTarget | null;
}>();

const emit = defineEmits<{
  select: [target: OpenProjectTarget];
  close: [];
}>();

function handleSelect(target: OpenProjectTarget): void {
  emit('select', target);
  emit('close');
}
</script>
