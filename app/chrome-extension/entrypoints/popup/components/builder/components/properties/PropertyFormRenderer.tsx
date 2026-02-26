import { useEffect, useMemo, useState } from 'react';

import type { FieldSpec, NodeSpec } from '@/entrypoints/popup/components/builder/model/node-spec';
import { getNodeSpec } from '@/entrypoints/popup/components/builder/model/node-spec-registry';
import {
  getWidget,
  registerDefaultWidgets,
} from '@/entrypoints/popup/components/builder/model/form-widget-registry';
import VarInput from '@/entrypoints/popup/components/builder/widgets/VarInput';
import type { VariableOption } from '@/entrypoints/popup/components/builder/model/variables';
import './PropertyFormRenderer.css';

type PropertyFormRendererProps = {
  node: any;
  variables?: VariableOption[];
};

type FieldRendererProps = {
  field: FieldSpec;
  value: any;
  variables?: VariableOption[];
  onChange: (value: any) => void;
};

function StringField({ field, value, variables, onChange }: FieldRendererProps) {
  return (
    <VarInput
      modelValue={value ?? ''}
      variables={variables || []}
      placeholder={field.placeholder}
      onUpdateModelValue={(next) => onChange(next)}
    />
  );
}

function NumberField({ field, value, onChange }: FieldRendererProps) {
  return (
    <input
      className="form-input"
      type="number"
      min={(field as any).min}
      max={(field as any).max}
      step={(field as any).step || 1}
      value={value ?? ''}
      onChange={(event) => {
        const next = event.currentTarget.value;
        onChange(next === '' ? undefined : Number(next));
      }}
    />
  );
}

function BoolField({ field, value, onChange }: FieldRendererProps) {
  return (
    <label className="checkbox-label">
      <input
        type="checkbox"
        checked={!!value}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>{field.label ?? ''}</span>
    </label>
  );
}

function SelectField({ field, value, onChange }: FieldRendererProps) {
  const options = (field as any).options || [];
  return (
    <select className="form-input" value={value ?? ''} onChange={(event) => onChange(event.currentTarget.value)}>
      {options.map((op: any) => (
        <option key={String(op.value)} value={op.value as any}>
          {op.label}
        </option>
      ))}
    </select>
  );
}

function JsonField({ value, onChange }: FieldRendererProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      setText(value != null ? JSON.stringify(value, null, 2) : '');
    } catch {
      setText('');
    }
  }, [value]);

  return (
    <div>
      <textarea
        className="form-input"
        rows={6}
        placeholder="Enter JSON"
        value={text}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          try {
            const parsed = next ? JSON.parse(next) : undefined;
            setError('');
            onChange(parsed);
          } catch {
            setError('JSON Format error');
          }
        }}
      />
      {error ? <div className="error-item">{error}</div> : null}
    </div>
  );
}

function DynamicField({ field, value, variables, onChange }: FieldRendererProps) {
  const widget = getWidget((field as any).widget);
  if (widget) {
    const Widget = widget;
    return (
      <Widget
        field={field}
        modelValue={value}
        variables={variables || []}
        onUpdateModelValue={onChange}
      />
    );
  }

  switch (field.type) {
    case 'string':
      return <StringField field={field} value={value} variables={variables} onChange={onChange} />;
    case 'number':
      return <NumberField field={field} value={value} variables={variables} onChange={onChange} />;
    case 'boolean':
      return <BoolField field={field} value={value} variables={variables} onChange={onChange} />;
    case 'select':
      return <SelectField field={field} value={value} variables={variables} onChange={onChange} />;
    case 'json':
      return <JsonField field={field} value={value} variables={variables} onChange={onChange} />;
    case 'object': {
      const fields = (field as any).fields || [];
      const objectValue = value && typeof value === 'object' ? value : {};

      return (
        <div className="nested">
          {fields.map((childField: FieldSpec) => (
            <div className="form-group" data-field={childField.key} key={childField.key}>
              <label className="form-label">{childField.label}</label>
              <DynamicField
                field={childField}
                value={objectValue[childField.key]}
                variables={variables}
                onChange={(next) => onChange({ ...objectValue, [childField.key]: next })}
              />
            </div>
          ))}
        </div>
      );
    }
    case 'array': {
      const itemField = (field as any).item as FieldSpec;
      const items = Array.isArray(value) ? value : [];

      function makeDefaultValue(): any {
        const itemType = (itemField as any).type;
        if (itemType === 'string') return '';
        if (itemType === 'number') return 0;
        if (itemType === 'boolean') return false;
        if (itemType === 'select') return (itemField as any).options?.[0]?.value ?? '';
        if (itemType === 'object') return {};
        if (itemType === 'json') return {};
        if (itemType === 'array') return [];
        return null;
      }

      return (
        <div className="array">
          {items.map((itemValue, index) => (
            <div className="array-item" key={index}>
              <DynamicField
                field={itemField}
                value={itemValue}
                variables={variables}
                onChange={(next) => {
                  const nextItems = [...items];
                  nextItems[index] = next;
                  onChange(nextItems);
                }}
              />
              <button
                className="btn-mini"
                type="button"
                onClick={() => {
                  const nextItems = [...items];
                  nextItems.splice(index, 1);
                  onChange(nextItems);
                }}
              >
                Delete
              </button>
            </div>
          ))}

          <button
            className="btn"
            type="button"
            onClick={() => {
              onChange([...items, makeDefaultValue()]);
            }}
          >
            New
          </button>
        </div>
      );
    }
    default:
      return <StringField field={field} value={value} variables={variables} onChange={onChange} />;
  }
}

export default function PropertyFormRenderer({ node, variables }: PropertyFormRendererProps) {
  const spec = useMemo<NodeSpec | undefined>(() => getNodeSpec(node?.type), [node?.type]);
  const schema = spec?.schema || [];

  const [model, setModel] = useState<Record<string, any>>({});

  useEffect(() => {
    registerDefaultWidgets();
  }, []);

  useEffect(() => {
    if (!node) return;
    if (!node.config) node.config = {};

    const defaults = spec?.defaults || {};
    for (const [key, value] of Object.entries(defaults)) {
      if (node.config[key] === undefined) {
        node.config[key] = value;
      }
    }

    setModel({ ...(node.config || {}) });
  }, [node?.id, node?.type, spec]);

  useEffect(() => {
    if (!node) return;
    node.config = { ...(node.config || {}), ...model };
  }, [model, node]);

  const errors = useMemo(() => {
    const cfg = node?.config || {};
    const output: string[] = [];

    for (const field of schema) {
      if (field.required && (cfg[field.key] === undefined || cfg[field.key] === '')) {
        output.push(`${field.label} Required`);
      }
    }

    try {
      const more = spec?.validate?.(cfg) || [];
      output.push(...more);
    } catch {
      // ignore
    }

    return output;
  }, [node, schema, spec, model]);

  return (
    <div className="form-section">
      <div className="section-title">Configuration</div>

      {schema.map((field) => (
        <div key={field.key} className="form-group" data-field={field.key}>
          <label className="form-label">{field.label}</label>
          <DynamicField
            field={field}
            value={model[field.key]}
            variables={variables}
            onChange={(next) => setModel((current) => ({ ...current, [field.key]: next }))}
          />
          {field.help ? <div className="help">{field.help}</div> : null}
        </div>
      ))}

      {errors.length ? (
        <div className="error-box">
          <div className="error-title">⚠️ Configuration error</div>
          {errors.map((error) => (
            <div key={error} className="error-item">
              {error}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
