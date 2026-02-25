import { useEffect, useMemo, useRef, useState } from 'react';

import type { VariableOption } from '../model/variables';
import { VAR_PLACEHOLDER, VAR_TOKEN_CLOSE, VAR_TOKEN_OPEN } from '../model/variables';
import './VarInput.css';

type VarInputProps = {
  modelValue: string;
  variables?: VariableOption[];
  placeholder?: string;
  format?: 'mustache' | 'workflowDot';
  onUpdateModelValue: (value: string) => void;
};

export default function VarInput({
  modelValue,
  variables = [],
  placeholder,
  format = 'mustache',
  onUpdateModelValue,
}: VarInputProps) {
  const inputEl = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const query = useMemo(() => {
    const val = String(modelValue || '');
    const pos = inputEl.current?.selectionStart ?? val.length;
    const before = val.slice(0, pos);
    const lastOpen = before.lastIndexOf(VAR_TOKEN_OPEN);
    const lastClose = before.lastIndexOf(VAR_TOKEN_CLOSE);
    if (lastOpen >= 0 && lastClose < lastOpen) {
      return before.slice(lastOpen + 1).trim();
    }
    if (val.includes(VAR_PLACEHOLDER)) {
      return '';
    }
    return '';
  }, [modelValue]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return variables;
    return variables.filter((item) => item.key.toLowerCase().startsWith(q));
  }, [query, variables]);

  function showSuggestIfNeeded(next: string) {
    try {
      const pos = inputEl.current?.selectionStart ?? next.length;
      const before = next.slice(0, pos);
      const shouldOpen = before.endsWith(VAR_TOKEN_OPEN) || next.includes(VAR_PLACEHOLDER);
      setOpen(shouldOpen);
      if (shouldOpen) {
        setActiveIdx(0);
      }
    } catch {
      setOpen(false);
    }
  }

  function insertVar(key: string) {
    const input = inputEl.current;
    const val = String(modelValue || '');
    const token = format === 'workflowDot' ? `workflow.${key}` : `${VAR_TOKEN_OPEN}${key}${VAR_TOKEN_CLOSE}`;

    if (!input) {
      onUpdateModelValue(`${val}${token}`);
      setOpen(false);
      return;
    }

    const start = input.selectionStart ?? val.length;
    const end = input.selectionEnd ?? start;
    const before = val.slice(0, start);
    const after = val.slice(end);
    const lastOpen = before.lastIndexOf(VAR_TOKEN_OPEN);
    const lastClose = before.lastIndexOf(VAR_TOKEN_CLOSE);

    let next: string;
    if (val.includes(VAR_PLACEHOLDER)) {
      const idx = val.indexOf(VAR_PLACEHOLDER);
      next = val.slice(0, idx) + token + val.slice(idx + 2);
    } else if (lastOpen >= 0 && lastClose < lastOpen) {
      next = val.slice(0, lastOpen) + token + after;
    } else {
      next = before + token + after;
    }

    onUpdateModelValue(next);

    requestAnimationFrame(() => {
      try {
        const pos =
          format === 'workflowDot'
            ? before.length + token.length
            : next.indexOf(VAR_TOKEN_CLOSE, lastOpen >= 0 ? lastOpen : start) + 1 || next.length;
        inputEl.current?.setSelectionRange(pos, pos);
      } catch {
        // ignore
      }
    });

    setOpen(false);
  }

  function onBlur() {
    setTimeout(() => {
      if (!hover) {
        setOpen(false);
      }
    }, 50);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === '{') {
      setTimeout(() => showSuggestIfNeeded(String(modelValue || '')), 0);
    }

    if ((event.ctrlKey || event.metaKey) && event.key === ' ') {
      event.preventDefault();
      setOpen(variables.length > 0);
      setActiveIdx(0);
      return;
    }

    if (!open) return;

    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIdx((current) => (current + 1) % Math.max(1, filtered.length));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIdx((current) => (current - 1 + Math.max(1, filtered.length)) % Math.max(1, filtered.length));
      return;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      if (!filtered.length) return;
      event.preventDefault();
      const idx = Math.max(0, Math.min(activeIdx, filtered.length - 1));
      insertVar(filtered[idx].key);
    }
  }

  useEffect(() => {
    if (document.activeElement === inputEl.current) {
      showSuggestIfNeeded(String(modelValue || ''));
    }
  }, [modelValue]);

  return (
    <div className="var-input-wrap">
      <input
        ref={inputEl}
        className="form-input"
        placeholder={placeholder}
        value={modelValue}
        onChange={(event) => {
          const next = event.currentTarget.value;
          onUpdateModelValue(next);
          showSuggestIfNeeded(next);
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onFocus={() => showSuggestIfNeeded(String(modelValue || ''))}
      />

      {open && filtered.length ? (
        <div
          className="var-suggest"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => {
            setHover(false);
            setOpen(false);
          }}
        >
          {filtered.map((item, index) => (
            <div
              key={`${item.key}:${item.nodeId || ''}`}
              className={index === activeIdx ? 'var-item active' : 'var-item'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertVar(item.key)}
              title={
                item.origin === 'node'
                  ? `${item.key} · from ${item.nodeName || item.nodeId}`
                  : `${item.key} · global`
              }
            >
              <span className="var-key">{item.key}</span>
              <span className="var-origin" data-origin={item.origin}>
                {item.origin === 'node' ? item.nodeName || item.nodeId || 'node' : 'global'}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
