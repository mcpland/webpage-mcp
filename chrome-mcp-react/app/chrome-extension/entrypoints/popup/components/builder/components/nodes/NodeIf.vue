<template>
  <div
    :class="['workflow-node', selected ? 'selected' : '', `type-${data.node.type}`]"
    @click="onSelect()"
  >
    <div v-if="hasErrors" class="node-error" :title="errorsTitle">
      <ILucideShieldX />
      <div class="tooltip">
        <div class="item" v-for="e in errList" :key="e">• {{ e }}</div>
      </div>
    </div>
    <div class="node-container">
      <div :class="['node-icon', `icon-${data.node.type}`]">
        <component :is="iconComp(data.node.type)" />
      </div>
      <div class="node-body">
        <div class="node-name">{{ data.node.name || getTypeLabel(data.node.type) }}</div>
        <div class="node-subtitle">{{ subtitle }}</div>
      </div>
    </div>

    <div class="if-cases">
      <div v-for="(b, idx) in branches" :key="b.id" class="case-row">
        <div class="case-label">{{ b.name || `条件${idx + 1}` }}</div>
        <Handle
          type="source"
          :position="Position.Right"
          :id="`case:${b.id}`"
          :class="['node-handle', hasOutgoingLabel(`case:${b.id}`) ? 'connected' : 'unconnected']"
        />
      </div>
      <div v-if="hasElse" class="case-row else-row">
        <div class="case-label">Else</div>
        <Handle
          type="source"
          :position="Position.Right"
          id="case:else"
          :class="['node-handle', hasOutgoingLabel('case:else') ? 'connected' : 'unconnected']"
        />
      </div>
    </div>

    <Handle
      type="target"
      :position="Position.Left"
      :class="['node-handle', hasIncoming ? 'connected' : 'unconnected']"
    />
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { NodeBase, Edge as EdgeV2 } from '@/entrypoints/background/record-replay/types';
import { Handle, Position } from '@vue-flow/core';
import { iconComp, getTypeLabel, nodeSubtitle } from './node-util';
import ILucideShieldX from '~icons/lucide/shield-x';

const props = defineProps<{
  id: string;
  data: { node: NodeBase; edges: EdgeV2[]; onSelect: (id: string) => void; errors?: string[] };
  selected?: boolean;
}>();

const hasIncoming = computed(
  () => props.data.edges?.some?.((e) => e && e.to === props.data.node.id) || false,
);
const branches = computed(() => {
  try {
    return Array.isArray((props.data.node as any)?.config?.branches)
      ? ((props.data.node as any).config.branches as any[]).map((x) => ({
          id: String(x.id || ''),
          name: x.name,
          expr: x.expr,
        }))
      : [];
  } catch {
    return [];
  }
});
const hasElse = computed(() => {
  try {
    return (props.data.node as any)?.config?.else !== false;
  } catch {
    return true;
  }
});
const subtitle = computed(() => nodeSubtitle(props.data.node));
const errList = computed(() => (props.data.errors || []) as string[]);
const hasErrors = computed(() => errList.value.length > 0);
const errorsTitle = computed(() => errList.value.join('\n'));

function hasOutgoingLabel(label: string) {
  try {
    return (props.data.edges || []).some(
      (e: any) => e && e.from === props.data.node.id && String(e.label || '') === String(label),
    );
  } catch {
    return false;
  }
}

function onSelect() {
  try {
    props.data.onSelect(props.id);
  } catch {}
}
</script>
