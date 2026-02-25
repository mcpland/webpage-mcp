// form-widget-registry.ts — global widget registry for PropertyFormRenderer
import FieldExpression from '@/entrypoints/popup/components/builder/widgets/FieldExpression.vue';
import FieldSelector from '@/entrypoints/popup/components/builder/widgets/FieldSelector.vue';
import FieldDuration from '@/entrypoints/popup/components/builder/widgets/FieldDuration.vue';
import FieldCode from '@/entrypoints/popup/components/builder/widgets/FieldCode.vue';
import FieldKeySequence from '@/entrypoints/popup/components/builder/widgets/FieldKeySequence.vue';
import FieldTargetLocator from '@/entrypoints/popup/components/builder/widgets/FieldTargetLocator.vue';
import type { Component } from 'vue';

const REG = new Map<string, Component>();

export function registerDefaultWidgets() {
  REG.set('expression', FieldExpression as unknown as Component);
  REG.set('selector', FieldSelector as unknown as Component);
  REG.set('duration', FieldDuration as unknown as Component);
  REG.set('code', FieldCode as unknown as Component);
  REG.set('keysequence', FieldKeySequence as unknown as Component);
  // Structured TargetLocator based on a selector input
  REG.set('targetlocator', FieldTargetLocator as unknown as Component);
}

export function getWidget(name?: string): Component | null {
  if (!name) return null;
  return REG.get(name) || null;
}
