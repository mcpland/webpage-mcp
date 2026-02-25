<template>
  <div class="form-section">
    <div class="section-header">
      <span class="section-title">If / else</span>
      <button class="btn-sm" @click="addIfCase">+ Add</button>
    </div>
    <div class="text-xs text-slate-500" style="padding: 0 20px"
      >使用表达式定义分支，支持变量与常见比较运算符。</div
    >
    <div class="if-case-list" data-field="if.branches">
      <div class="if-case-item" v-for="(c, i) in ifBranches" :key="c.id">
        <div class="if-case-header">
          <input class="form-input-sm flex-1" v-model="c.name" placeholder="分支名称（可选）" />
          <button class="btn-icon-sm danger" @click="removeIfCase(i)" title="删除">×</button>
        </div>
        <div class="if-case-expr">
          <VarInput
            v-model="c.expr"
            :variables="variablesNormalized"
            format="workflowDot"
            :placeholder="'workflow.' + (variablesNormalized[0]?.key || 'var') + ' == 5'"
          />
          <div class="if-toolbar">
            <select
              class="form-select-sm"
              @change="(e: any) => insertVar(e.target.value, i)"
              :value="''"
            >
              <option value="" disabled>插入变量</option>
              <option v-for="v in variables" :key="v.key" :value="v.key">{{ v.key }}</option>
            </select>
            <select
              class="form-select-sm"
              @change="(e: any) => insertOp(e.target.value, i)"
              :value="''"
            >
              <option value="" disabled>运算符</option>
              <option v-for="op in ops" :key="op" :value="op">{{ op }}</option>
            </select>
          </div>
        </div>
      </div>
      <div class="if-case-else" v-if="elseEnabled">
        <div class="text-xs text-slate-500">Else 分支（无需表达式，将匹配以上条件都不成立时）</div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import { computed } from 'vue';
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
import { newId } from '@/entrypoints/popup/components/builder/model/transforms';

import VarInput from '@/entrypoints/popup/components/builder/widgets/VarInput.vue';
import type { VariableOption } from '@/entrypoints/popup/components/builder/model/variables';
const props = defineProps<{ node: NodeBase; variables?: Array<{ key: string }> }>();
const variablesNormalized = computed<VariableOption[]>(() =>
  (props.variables || []).map((v) => ({ key: v.key, origin: 'global' }) as VariableOption),
);

const ops = ['==', '!=', '>', '>=', '<', '<=', '&&', '||'];
const ifBranches = computed<Array<{ id: string; name?: string; expr: string }>>({
  get() {
    try {
      return Array.isArray((props.node as any)?.config?.branches)
        ? ((props.node as any).config.branches as any[])
        : [];
    } catch {
      return [] as any;
    }
  },
  set(arr) {
    try {
      (props.node as any).config.branches = arr;
    } catch {}
  },
});
const elseEnabled = computed<boolean>({
  get() {
    try {
      return (props.node as any)?.config?.else !== false;
    } catch {
      return true;
    }
  },
  set(v) {
    try {
      (props.node as any).config.else = !!v;
    } catch {}
  },
});

function addIfCase() {
  const arr = ifBranches.value.slice();
  arr.push({ id: newId('case'), name: '', expr: '' });
  ifBranches.value = arr;
}
function removeIfCase(i: number) {
  const arr = ifBranches.value.slice();
  arr.splice(i, 1);
  ifBranches.value = arr;
}
function insertVar(key: string, idx: number) {
  if (!key) return;
  const arr = ifBranches.value.slice();
  const token = `workflow.${key}`;
  arr[idx].expr = String(arr[idx].expr || '') + (arr[idx].expr ? ' ' : '') + token;
  ifBranches.value = arr;
}
function insertOp(op: string, idx: number) {
  if (!op) return;
  const arr = ifBranches.value.slice();
  arr[idx].expr = String(arr[idx].expr || '') + (arr[idx].expr ? ' ' : '') + op;
  ifBranches.value = arr;
}
</script>

<style scoped></style>
