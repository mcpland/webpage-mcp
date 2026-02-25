<template>
  <div class="form-section">
    <div class="section-title">配置</div>
    <div v-for="field in schema" :key="field.key" class="form-group" :data-field="field.key">
      <label class="form-label">{{ field.label }}</label>
      <component
        :is="resolveField(field)"
        :field="field"
        v-model="model[field.key]"
        :variables="variables"
      />
      <div v-if="field.help" class="help">{{ field.help }}</div>
    </div>

    <div v-if="errors.length" class="error-box">
      <div class="error-title">⚠️ 配置错误</div>
      <div v-for="e in errors" :key="e" class="error-item">{{ e }}</div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, reactive, watch, defineComponent, h, ref } from 'vue';
import type { FieldSpec, NodeSpec } from '@/entrypoints/popup/components/builder/model/node-spec';
import { getNodeSpec } from '@/entrypoints/popup/components/builder/model/node-spec-registry';
import {
  getWidget,
  registerDefaultWidgets,
} from '@/entrypoints/popup/components/builder/model/form-widget-registry';
import VarInput from '@/entrypoints/popup/components/builder/widgets/VarInput.vue';
import type { VariableOption } from '@/entrypoints/popup/components/builder/model/variables';

const props = defineProps<{
  node: any; // NodeBase
  variables?: VariableOption[];
}>();

// Fetch spec by node.type
const spec = computed<NodeSpec | undefined>(() => getNodeSpec(props.node?.type));
const schema = computed<FieldSpec[]>(() => spec.value?.schema || []);

// Config model references node.config; ensure defaults applied on mount
const model = reactive<any>({});

function applyDefaults() {
  if (!props.node) return;
  if (!props.node.config) props.node.config = {};
  const defaults = spec.value?.defaults || {};
  for (const [k, v] of Object.entries(defaults))
    if (props.node.config[k] === undefined) props.node.config[k] = v;
  Object.assign(model, props.node.config);
}

onMounted(applyDefaults);
registerDefaultWidgets();
watch(
  () => props.node?.id,
  () => applyDefaults(),
);
watch(
  model,
  () => {
    if (!props.node) return;
    props.node.config = { ...(props.node.config || {}), ...model };
  },
  { deep: true },
);

const errors = computed(() => {
  const cfg = props.node?.config || {};
  const out: string[] = [];
  for (const f of schema.value)
    if (f.required && (cfg[f.key] === undefined || cfg[f.key] === '')) out.push(`${f.label} 必填`);
  try {
    const more = spec.value?.validate?.(cfg) || [];
    out.push(...more);
  } catch {}
  return out;
});

function resolveField(field: FieldSpec) {
  const w = getWidget((field as any).widget);
  if (w) return w as any;
  switch (field.type) {
    case 'string':
      return StringField;
    case 'number':
      return NumberField;
    case 'boolean':
      return BoolField;
    case 'select':
      return SelectField;
    case 'object':
      return ObjectField;
    case 'array':
      return ArrayField;
    case 'json':
      return JsonField;
    default:
      return StringField;
  }
}

// Field components without runtime templates (render functions)
const StringField = defineComponent({
  name: 'StringField',
  props: ['field', 'modelValue', 'variables'],
  emits: ['update:modelValue'],
  setup(p: any, { emit }) {
    return () =>
      h(VarInput as any, {
        modelValue: p.modelValue ?? '',
        variables: (p.variables || []) as VariableOption[],
        placeholder: p.field?.placeholder,
        'onUpdate:modelValue': (v: string) => emit('update:modelValue', v),
      });
  },
});

const NumberField = defineComponent({
  name: 'NumberField',
  props: ['field', 'modelValue'],
  emits: ['update:modelValue'],
  setup(props: any, { emit }) {
    return () =>
      h('input', {
        class: 'form-input',
        type: 'number',
        min: props.field?.min,
        max: props.field?.max,
        step: props.field?.step || 1,
        value: props.modelValue ?? '',
        onInput: (e: any) => emit('update:modelValue', e?.target?.valueAsNumber),
      });
  },
});

const BoolField = defineComponent({
  name: 'BoolField',
  props: ['field', 'modelValue'],
  emits: ['update:modelValue'],
  setup(props: any, { emit }) {
    return () =>
      h('label', { class: 'checkbox-label' }, [
        h('input', {
          type: 'checkbox',
          checked: !!props.modelValue,
          onChange: (e: any) => emit('update:modelValue', !!e?.target?.checked),
        }),
        h('span', null, props.field?.label ?? ''),
      ]);
  },
});

const SelectField = defineComponent({
  name: 'SelectField',
  props: ['field', 'modelValue'],
  emits: ['update:modelValue'],
  setup(props: any, { emit }) {
    return () =>
      h(
        'select',
        {
          class: 'form-input',
          value: props.modelValue,
          onChange: (e: any) => emit('update:modelValue', e?.target?.value),
        },
        (props.field?.options || []).map((op: any) =>
          h('option', { value: op.value, key: String(op.value) }, op.label),
        ),
      );
  },
});

const JsonField = defineComponent({
  name: 'JsonField',
  props: ['field', 'modelValue'],
  emits: ['update:modelValue'],
  setup(props: any, { emit }) {
    const text = ref<string>('');
    const err = ref<string>('');
    onMounted(() => {
      try {
        text.value = props.modelValue != null ? JSON.stringify(props.modelValue, null, 2) : '';
      } catch {
        text.value = '';
      }
    });
    watch(text, () => {
      try {
        const v = text.value ? JSON.parse(text.value) : undefined;
        err.value = '';
        emit('update:modelValue', v);
      } catch (e) {
        err.value = 'JSON 格式错误';
      }
    });
    return () =>
      h('div', null, [
        h('textarea', {
          class: 'form-input',
          rows: 6,
          placeholder: '输入 JSON',
          value: text.value,
          onInput: (e: any) => (text.value = String(e?.target?.value ?? '')),
        }),
        err.value ? h('div', { class: 'error-item' }, err.value) : null,
      ]);
  },
});

const ObjectField = defineComponent({
  name: 'ObjectField',
  props: ['field', 'modelValue'],
  emits: ['update:modelValue'],
  setup(props: any, { emit }) {
    const local = ref<Record<string, any>>({ ...(props.modelValue || {}) });
    const compOf = (f: any) => {
      const w = getWidget(f.widget);
      if (w) return w as any;
      if (f.type === 'string') return StringField;
      if (f.type === 'number') return NumberField;
      if (f.type === 'boolean') return BoolField;
      if (f.type === 'select') return SelectField;
      if (f.type === 'json') return JsonField;
      if (f.type === 'object') return ObjectField;
      if (f.type === 'array') return ArrayField;
      return StringField;
    };
    watch(
      () => local.value,
      () => emit('update:modelValue', local.value),
      { deep: true },
    );
    return () =>
      h(
        'div',
        { class: 'nested' },
        (props.field?.fields || []).map((f: any) =>
          h('div', { class: 'form-group', 'data-field': f.key, key: f.key }, [
            h('label', { class: 'form-label' }, f.label),
            h(compOf(f), {
              field: f,
              modelValue: local.value[f.key],
              'onUpdate:modelValue': (v: any) => (local.value = { ...local.value, [f.key]: v }),
              variables: props.variables || [],
            }),
          ]),
        ),
      );
  },
});

const ArrayField = defineComponent({
  name: 'ArrayField',
  props: ['field', 'modelValue'],
  emits: ['update:modelValue'],
  setup(props: any, { emit }) {
    const items = ref<any[]>(Array.isArray(props.modelValue) ? [...props.modelValue] : []);
    const update = () => emit('update:modelValue', items.value);
    const add = () => {
      const it = props.field.item as any;
      let v: any = null;
      if (it.type === 'string') v = '';
      else if (it.type === 'number') v = 0;
      else if (it.type === 'boolean') v = false;
      else if (it.type === 'select') v = it.options?.[0]?.value ?? '';
      else if (it.type === 'object') v = {};
      else if (it.type === 'json') v = {};
      else if (it.type === 'array') v = [];
      items.value.push(v);
      update();
    };
    const remove = (i: number) => {
      items.value.splice(i, 1);
      update();
    };
    const compOf = (f: any) => {
      const w = getWidget(f.widget);
      if (w) return w as any;
      if (f.type === 'string') return StringField;
      if (f.type === 'number') return NumberField;
      if (f.type === 'boolean') return BoolField;
      if (f.type === 'select') return SelectField;
      if (f.type === 'json') return JsonField;
      if (f.type === 'object') return ObjectField;
      if (f.type === 'array') return ArrayField;
      return StringField;
    };
    return () =>
      h('div', { class: 'array' }, [
        ...items.value.map((_, i) =>
          h('div', { class: 'array-item', key: i }, [
            h(compOf(props.field.item), {
              field: props.field.item,
              modelValue: items.value[i],
              'onUpdate:modelValue': (v: any) => {
                items.value[i] = v;
                update();
              },
              variables: props.variables || [],
            }),
            h('button', { class: 'btn-mini', type: 'button', onClick: () => remove(i) }, '删除'),
          ]),
        ),
        h('button', { class: 'btn', type: 'button', onClick: add }, '新增'),
      ]);
  },
});
</script>

<style scoped></style>
<style scoped>
.form-section {
  padding: 8px 12px;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--rr-text);
  margin-bottom: 6px;
}
.form-group {
  margin-bottom: 10px;
}
.form-label {
  display: block;
  font-size: 12px;
  color: var(--rr-dim);
  margin-bottom: 4px;
}
.help {
  font-size: 11px;
  color: var(--rr-dim);
  margin-top: 4px;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--rr-text);
}
.nested {
  border-left: 2px solid var(--rr-border);
  padding-left: 8px;
}
.array-item {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.btn-mini {
  font-size: 12px;
  padding: 2px 6px;
  border: 1px solid var(--rr-border);
  border-radius: 6px;
}
.btn {
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid var(--rr-border);
  border-radius: 8px;
}
.form-input {
  width: 100%;
  border: 1px solid var(--rr-border);
  border-radius: 8px;
  padding: 6px 8px;
  background: var(--rr-card-2);
  color: var(--rr-text);
}
.error-box {
  background: rgba(255, 102, 102, 0.06);
  border: 1px solid rgba(255, 102, 102, 0.25);
  color: #ff6666;
  border-radius: 8px;
  padding: 6px 8px;
  margin-top: 8px;
}
.error-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
}
.error-item {
  font-size: 12px;
}
</style>
