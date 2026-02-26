import { useEffect, useState } from 'react';
import './FieldCode.css';

type FieldCodeProps = {
  modelValue?: string;
  field?: { placeholder?: string };
  onUpdateModelValue: (value?: string) => void;
};

export default function FieldCode({ modelValue, field, onUpdateModelValue }: FieldCodeProps) {
  const [text, setText] = useState(modelValue ?? '');
  const placeholder = field?.placeholder || '/* code */';

  useEffect(() => {
    setText(modelValue ?? '');
  }, [modelValue]);

  return (
    <div className="code">
      <textarea
        className="form-input mono"
        rows={6}
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          onUpdateModelValue(next);
        }}
      />
    </div>
  );
}
