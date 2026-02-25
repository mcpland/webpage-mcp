<template>
  <div class="form-section">
    <div class="section-header">
      <span class="section-title">{{ title || '选择器' }}</span>
      <button v-if="allowPick" class="btn-sm btn-primary" @click="pickFromPage">从页面选择</button>
    </div>
    <div class="selector-list" data-field="target.candidates">
      <div class="selector-item" v-for="(c, i) in list" :key="i">
        <select class="form-select-sm" v-model="c.type">
          <option value="css">CSS</option>
          <option value="attr">Attr</option>
          <option value="aria">ARIA</option>
          <option value="text">Text</option>
          <option value="xpath">XPath</option>
        </select>
        <input class="form-input-sm flex-1" v-model="c.value" placeholder="选择器值" />
        <button class="btn-icon-sm" @click="move(i, -1)" :disabled="i === 0">↑</button>
        <button class="btn-icon-sm" @click="move(i, 1)" :disabled="i === list.length - 1">↓</button>
        <button class="btn-icon-sm danger" @click="remove(i)">×</button>
      </div>
      <button class="btn-sm" @click="add">+ 添加选择器</button>
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import type { NodeBase } from '@/entrypoints/background/record-replay/types';

const props = defineProps<{
  node: NodeBase;
  allowPick?: boolean;
  targetKey?: string;
  title?: string;
}>();
const key = (props.targetKey || 'target') as string;

function ensureTarget() {
  const n: any = props.node;
  if (!n.config) n.config = {};
  if (!n.config[key]) n.config[key] = { candidates: [] };
  if (!Array.isArray(n.config[key].candidates)) n.config[key].candidates = [];
}

const list = {
  get value() {
    ensureTarget();
    return ((props.node as any).config[key].candidates || []) as Array<{
      type: string;
      value: string;
    }>;
  },
} as any as Array<{ type: string; value: string }>;

function add() {
  ensureTarget();
  (props.node as any).config[key].candidates.push({ type: 'css', value: '' });
}
function remove(i: number) {
  ensureTarget();
  (props.node as any).config[key].candidates.splice(i, 1);
}
function move(i: number, d: number) {
  ensureTarget();
  const arr = (props.node as any).config[key].candidates as any[];
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  const t = arr[i];
  arr[i] = arr[j];
  arr[j] = t;
}

async function ensurePickerInjected(tabId: number) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { action: 'chrome_read_page_ping' } as any);
    if (pong && pong.status === 'pong') return;
  } catch {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['inject-scripts/accessibility-tree-helper.js'],
      world: 'ISOLATED',
    } as any);
  } catch (e) {
    console.warn('inject picker helper failed:', e);
  }
}

async function pickFromPage() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (typeof tabId !== 'number') return;
    await ensurePickerInjected(tabId);
    const resp: any = await chrome.tabs.sendMessage(tabId, { action: 'rr_picker_start' } as any);
    if (!resp || !resp.success) return;
    ensureTarget();
    const n: any = props.node;
    const arr = Array.isArray(resp.candidates) ? resp.candidates : [];
    const seen = new Set<string>();
    const merged: any[] = [];
    for (const c of arr) {
      if (!c || !c.type || !c.value) continue;
      const key = `${c.type}|${c.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({ type: String(c.type), value: String(c.value) });
      }
    }
    n.config[key].candidates = merged;
  } catch (e) {
    console.warn('pickFromPage failed:', e);
  }
}
</script>

<style scoped>
/* No local styles; inherit from parent panel via :deep selectors */
</style>
