import { useEffect, useState } from 'react';
import { getMessage } from '@/utils/i18n';

type FieldKeySequenceProps = {
  modelValue?: string;
  field?: { placeholder?: string };
  onUpdateModelValue: (value?: string) => void;
};

export default function FieldKeySequence({ modelValue, field, onUpdateModelValue }: FieldKeySequenceProps) {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);
  const [text, setText] = useState(modelValue ?? '');
  const placeholder = field?.placeholder || t('builderKeySequencePlaceholder', 'Backspace Enter or cmd+a');

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
      <div className="help">
        {t('builderKeySequenceExample', 'Example: Backspace Enter or cmd+a')}
      </div>
    </div>
  );
}
