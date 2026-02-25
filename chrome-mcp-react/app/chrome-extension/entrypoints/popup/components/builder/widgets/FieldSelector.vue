<template>
  <div class="selector">
    <div class="row">
      <input class="form-input" :placeholder="placeholder" :value="text" @input="onInput" />
      <button class="btn-mini" type="button" title="从页面拾取" @click="onPick">拾取</button>
    </div>
    <div class="help">可输入 CSS 选择器，或点击“拾取”在页面中选择元素</div>
    <div v-if="err" class="error-item">{{ err }}</div>
  </div>
</template>

<script lang="ts" setup>
import { ref, watchEffect } from 'vue';
const props = defineProps<{ modelValue?: string; field?: any }>();
const emit = defineEmits<{ (e: 'update:modelValue', v?: string): void }>();
const text = ref<string>(props.modelValue ?? '');
const placeholder = props.field?.placeholder || '.btn.primary';
function onInput(ev: any) {
  const v = String(ev?.target?.value ?? '');
  text.value = v;
  emit('update:modelValue', v);
}
watchEffect(() => (text.value = props.modelValue ?? ''));

const err = ref<string>('');
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

async function onPick() {
  try {
    err.value = '';
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (!tabId) throw new Error('未找到活动页签');
    await ensurePickerInjected(tabId);
    const res: any = await chrome.tabs.sendMessage(tabId, { action: 'rr_picker_start' } as any);
    if (!res || !res.success) {
      if (res?.cancelled) return;
      throw new Error(res?.error || '拾取失败');
    }
    const candidates = Array.isArray(res.candidates) ? res.candidates : [];
    const prefer = ['css', 'attr', 'aria', 'text'];
    let sel = '';
    for (const t of prefer) {
      const c = candidates.find((x: any) => x.type === t && x.value);
      if (c) {
        sel = String(c.value);
        break;
      }
    }
    if (!sel && candidates[0]?.value) sel = String(candidates[0].value);
    if (sel) {
      text.value = sel;
      emit('update:modelValue', sel);
    } else {
      err.value = '未生成有效选择器，请手动输入';
    }
  } catch (e: any) {
    err.value = e?.message || String(e);
  }
}
</script>

<style scoped>
.row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.btn-mini {
  font-size: 12px;
  padding: 2px 6px;
  border: 1px solid var(--rr-border);
  border-radius: 6px;
}
.error-item {
  font-size: 12px;
  color: #ff6666;
  margin-top: 6px;
}
</style>
