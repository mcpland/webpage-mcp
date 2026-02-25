<template>
  <div
    class="px-4 py-2 border-b border-slate-100 flex flex-col gap-2 text-xs text-slate-600 bg-slate-50"
  >
    <!-- Project selection & workspace -->
    <div class="flex items-center gap-2">
      <span class="whitespace-nowrap">Project</span>
      <select
        :value="selectedProjectId"
        class="flex-1 border border-slate-200 rounded px-2 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-slate-400"
        @change="handleProjectChange"
      >
        <option v-for="p in projects" :key="p.id" :value="p.id">
          {{ p.name }}
        </option>
      </select>
      <button
        class="btn-secondary !px-2 !py-1 text-[11px]"
        type="button"
        :disabled="isPicking"
        title="Create new project from a directory"
        @click="$emit('new-project')"
      >
        {{ isPicking ? '...' : 'New' }}
      </button>
    </div>

    <!-- Current workspace path -->
    <div v-if="selectedProject" class="flex items-center gap-2 text-[11px] text-slate-500">
      <span class="whitespace-nowrap">Path</span>
      <span class="flex-1 font-mono truncate" :title="selectedProject.rootPath">
        {{ selectedProject.rootPath }}
      </span>
    </div>

    <!-- CLI & Model selection -->
    <CliSettings
      :project-root="projectRoot"
      :selected-cli="selectedCli"
      :model="model"
      :use-ccr="useCcr"
      :engines="engines"
      :selected-project="selectedProject"
      :is-saving-root="isSavingProjectRoot"
      :is-saving-preference="isSavingPreference"
      @update:project-root="$emit('update:projectRoot', $event)"
      @update:selected-cli="$emit('update:selectedCli', $event)"
      @update:model="$emit('update:model', $event)"
      @update:use-ccr="$emit('update:useCcr', $event)"
      @save-root="$emit('save-root')"
      @save-preference="$emit('save-preference')"
    />

    <!-- Error message -->
    <div v-if="error" class="text-[11px] text-red-600">
      {{ error }}
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { AgentProject, AgentEngineInfo } from 'webpage-mcp-shared';
import CliSettings from './CliSettings.vue';

defineProps<{
  projects: AgentProject[];
  selectedProjectId: string;
  selectedProject: AgentProject | null;
  isPicking: boolean;
  error: string | null;
  projectRoot: string;
  selectedCli: string;
  model: string;
  useCcr: boolean;
  engines: AgentEngineInfo[];
  isSavingProjectRoot: boolean;
  isSavingPreference: boolean;
}>();

const emit = defineEmits<{
  'update:selectedProjectId': [value: string];
  'project-changed': [];
  'new-project': [];
  'update:projectRoot': [value: string];
  'update:selectedCli': [value: string];
  'update:model': [value: string];
  'update:useCcr': [value: boolean];
  'save-root': [];
  'save-preference': [];
}>();

function handleProjectChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  emit('update:selectedProjectId', value);
  emit('project-changed');
}
</script>
