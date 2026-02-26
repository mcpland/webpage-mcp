import { useEffect, useState } from 'react';
import './FieldSelector.css';

type FieldSelectorProps = {
  modelValue?: string;
  field?: { placeholder?: string };
  onUpdateModelValue: (value?: string) => void;
};

async function ensurePickerInjected(tabId: number) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { action: 'chrome_read_page_ping' } as any);
    if (pong && pong.status === 'pong') return;
  } catch {
    // continue
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['inject-scripts/accessibility-tree-helper.js'],
      world: 'ISOLATED',
    } as any);
  } catch (error) {
    console.warn('inject picker helper failed:', error);
  }
}

export default function FieldSelector({ modelValue, field, onUpdateModelValue }: FieldSelectorProps) {
  const [text, setText] = useState(modelValue ?? '');
  const [error, setError] = useState('');
  const placeholder = field?.placeholder || '.btn.primary';

  useEffect(() => {
    setText(modelValue ?? '');
  }, [modelValue]);

  async function onPick() {
    try {
      setError('');
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs?.[0]?.id;
      if (!tabId) throw new Error('Event tab not found');

      await ensurePickerInjected(tabId);
      const result: any = await chrome.tabs.sendMessage(tabId, { action: 'rr_picker_start' } as any);

      if (!result || !result.success) {
        if (result?.cancelled) return;
        throw new Error(result?.error || 'Pickup failed');
      }

      const candidates = Array.isArray(result.candidates) ? result.candidates : [];
      const prefer = ['css', 'attr', 'aria', 'text'];
      let selected = '';

      for (const type of prefer) {
        const candidate = candidates.find((item: any) => item.type === type && item.value);
        if (candidate) {
          selected = String(candidate.value);
          break;
        }
      }

      if (!selected && candidates[0]?.value) {
        selected = String(candidates[0].value);
      }

      if (selected) {
        setText(selected);
        onUpdateModelValue(selected);
      } else {
        setError('No valid selector was generated, please enter it manually');
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    }
  }

  return (
    <div className="selector">
      <div className="row">
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
        <button className="btn-mini" type="button" title="Picked up from page" onClick={() => void onPick()}>
          pick up
        </button>
      </div>
      <div className="help">You can enter a CSS selector or click Pick to select an element on the page</div>
      {error ? <div className="error-item">{error}</div> : null}
    </div>
  );
}
