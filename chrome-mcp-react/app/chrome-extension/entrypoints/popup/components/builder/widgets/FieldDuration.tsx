import { useEffect, useState } from 'react';
import './FieldDuration.css';

type FieldDurationProps = {
  modelValue?: number;
  onUpdateModelValue: (value?: number) => void;
};

export default function FieldDuration({ modelValue, onUpdateModelValue }: FieldDurationProps) {
  const [unit, setUnit] = useState<'ms' | 's'>('ms');
  const [value, setValue] = useState(Number(modelValue || 0));

  useEffect(() => {
    const ms = Number(modelValue || 0);
    if (ms % 1000 === 0 && ms >= 1000) {
      setUnit('s');
      setValue(ms / 1000);
    } else {
      setUnit('ms');
      setValue(ms);
    }
  }, [modelValue]);

  return (
    <div className="duration">
      <div className="row">
        <input
          className="form-input"
          type="number"
          min="0"
          value={value}
          onChange={(event) => {
            const next = Number(event.currentTarget.value || 0);
            setValue(next);
            onUpdateModelValue(unit === 's' ? next * 1000 : next);
          }}
        />
        <select
          className="form-input unit"
          value={unit}
          onChange={(event) => {
            const nextUnit = event.currentTarget.value === 's' ? 's' : 'ms';
            setUnit(nextUnit);
            onUpdateModelValue(nextUnit === 's' ? value * 1000 : value);
          }}
        >
          <option value="ms">ms</option>
          <option value="s">s</option>
        </select>
      </div>
    </div>
  );
}
