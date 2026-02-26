import { useEffect, useState } from 'react';

type FieldKeySequenceProps = {
  modelValue?: string;
  field?: { placeholder?: string };
  onUpdateModelValue: (value?: string) => void;
};

export default function FieldKeySequence({ modelValue, field, onUpdateModelValue }: FieldKeySequenceProps) {
  const [text, setText] = useState(modelValue ?? '');
  const placeholder = field?.placeholder || 'Backspace Enter or cmd+a';

  useEffect(() => {
    setText(modelValue ?? '');
  }, [modelValue]);

  return (
    <div className="keys">
      <input
        className="form-input"
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          onUpdateModelValue(next);
        }}
      />
      <div className="help">Example: Backspace Enter or cmd+a</div>
    </div>
  );
}
