import { useEffect, useState } from 'react';

import { evalExpression } from '@/entrypoints/background/record-replay/engine/utils/expression';
import './FieldCode.css';

type FieldExpressionProps = {
  modelValue?: string;
  field?: { placeholder?: string };
  onUpdateModelValue: (value?: string) => void;
};

export default function FieldExpression({ modelValue, field, onUpdateModelValue }: FieldExpressionProps) {
  const [text, setText] = useState(modelValue ?? '');
  const [error, setError] = useState('');
  const placeholder = field?.placeholder || 'e.g. vars.a > 0 && vars.flag';

  useEffect(() => {
    setText(modelValue ?? '');
  }, [modelValue]);

  return (
    <div className="expr">
      <input
        className="form-input mono"
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);

          try {
            if (next.trim()) {
              evalExpression(next, { vars: {} as any });
            }
            setError('');
          } catch {
            setError('Expression parsing error');
          }

          onUpdateModelValue(next);
        }}
      />
      {error ? <div className="error-item">{error}</div> : null}
    </div>
  );
}
