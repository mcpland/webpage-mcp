import { useEffect, useRef, useState } from 'react';

import FieldSelector from './FieldSelector';
import './FieldTargetLocator.css';

type Candidate = { type: 'css' | 'attr' | 'aria' | 'text' | 'xpath'; value: string };
type TargetLocator = { ref?: string; candidates?: Candidate[] };

type FieldTargetLocatorProps = {
  modelValue?: TargetLocator | string;
  field?: { placeholder?: string };
  onUpdateModelValue: (value?: TargetLocator) => void;
};

export default function FieldTargetLocator({
  modelValue,
  field,
  onUpdateModelValue,
}: FieldTargetLocatorProps) {
  const [text, setText] = useState('');
  const updatingFromProps = useRef(false);

  const placeholder = field?.placeholder || '.btn.primary';

  useEffect(() => {
    updatingFromProps.current = true;

    if (!modelValue) {
      setText('');
      queueMicrotask(() => {
        updatingFromProps.current = false;
      });
      return;
    }

    if (typeof modelValue === 'string') {
      setText(modelValue);
      queueMicrotask(() => {
        updatingFromProps.current = false;
      });
      return;
    }

    try {
      const arr: Candidate[] = Array.isArray((modelValue as any).candidates)
        ? ((modelValue as any).candidates as Candidate[])
        : [];

      const prefer = ['css', 'attr', 'aria', 'text', 'xpath'];
      let value = '';
      for (const type of prefer) {
        const found = arr.find((item) => item && item.type === type && item.value);
        if (found) {
          value = String(found.value || '');
          break;
        }
      }

      if (!value) {
        value = arr[0]?.value ? String(arr[0].value) : '';
      }

      setText(value);
    } catch {
      setText('');
    }

    queueMicrotask(() => {
      updatingFromProps.current = false;
    });
  }, [modelValue]);

  function onTextChange(next: string) {
    setText(next);
    if (updatingFromProps.current) return;

    const trimmed = String(next || '').trim();
    if (!trimmed) {
      onUpdateModelValue({ candidates: [] });
      return;
    }

    onUpdateModelValue({
      ...(typeof modelValue === 'object' && modelValue ? (modelValue as any) : {}),
      candidates: [{ type: 'css', value: trimmed }],
    });
  }

  return (
    <div className="target-locator">
      <FieldSelector modelValue={text} field={{ placeholder }} onUpdateModelValue={onTextChange} />
    </div>
  );
}
