// form-widget-registry.ts — global widget registry for PropertyFormRenderer
import type { ComponentType } from 'react';

import FieldExpression from '@/entrypoints/popup/components/builder/widgets/FieldExpression';
import FieldSelector from '@/entrypoints/popup/components/builder/widgets/FieldSelector';
import FieldDuration from '@/entrypoints/popup/components/builder/widgets/FieldDuration';
import FieldCode from '@/entrypoints/popup/components/builder/widgets/FieldCode';
import FieldKeySequence from '@/entrypoints/popup/components/builder/widgets/FieldKeySequence';
import FieldTargetLocator from '@/entrypoints/popup/components/builder/widgets/FieldTargetLocator';
import type { VariableOption } from './variables';

export type WidgetComponentProps<T = any> = {
  field?: any;
  modelValue?: T;
  variables?: VariableOption[];
  onUpdateModelValue: (value: T) => void;
};

export type WidgetComponent = ComponentType<WidgetComponentProps<any>>;

const REG = new Map<string, WidgetComponent>();

export function registerDefaultWidgets() {
  REG.set('expression', FieldExpression as unknown as WidgetComponent);
  REG.set('selector', FieldSelector as unknown as WidgetComponent);
  REG.set('duration', FieldDuration as unknown as WidgetComponent);
  REG.set('code', FieldCode as unknown as WidgetComponent);
  REG.set('keysequence', FieldKeySequence as unknown as WidgetComponent);
  // Structured TargetLocator based on a selector input
  REG.set('targetlocator', FieldTargetLocator as unknown as WidgetComponent);
}

export function getWidget(name?: string): WidgetComponent | null {
  if (!name) return null;
  return REG.get(name) || null;
}
