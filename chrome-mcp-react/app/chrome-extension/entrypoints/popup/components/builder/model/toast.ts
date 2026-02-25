// toast.ts - lightweight toast event bus for builder UI
// Usage: import { toast } and call toast('message', 'warn'|'error'|'info')

export type ToastLevel = 'info' | 'warn' | 'error';

export function toast(message: string, level: ToastLevel = 'warn') {
  try {
    const ev = new CustomEvent('rr_toast', { detail: { message: String(message), level } });
    window.dispatchEvent(ev);
  } catch {
    // as a last resort
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log']('[toast]', message);
  }
}
