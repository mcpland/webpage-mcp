import type { NodeBase } from '@/entrypoints/background/record-replay/types';
import { summarizeNode as summarize } from '../../model/transforms';

export function getTypeGlyph(type?: string): string {
  switch (type) {
    case 'trigger':
      return '⚡';
    case 'click':
    case 'dblclick':
      return '🖱';
    case 'fill':
      return '✎';
    case 'drag':
      return '↕';
    case 'scroll':
      return '⇵';
    case 'key':
      return '⌨';
    case 'navigate':
      return '🧭';
    case 'http':
      return '🌐';
    case 'script':
      return '</>';
    case 'screenshot':
      return '📷';
    case 'triggerEvent':
      return '🔔';
    case 'setAttribute':
      return '🔧';
    case 'loopElements':
    case 'foreach':
    case 'while':
      return '↻';
    case 'switchFrame':
      return '🧩';
    case 'handleDownload':
      return '⬇';
    case 'extract':
      return '🔍';
    case 'wait':
    case 'delay':
      return '⏳';
    case 'assert':
      return '✓';
    case 'if':
      return '⑂';
    case 'openTab':
      return '▢';
    case 'switchTab':
      return '⇆';
    case 'closeTab':
      return '✕';
    default:
      return '•';
  }
}

export function getTypeLabel(type?: string) {
  const labels: Record<string, string> = {
    trigger: 'trigger',
    click: 'click',
    fill: 'fill',
    navigate: 'Navigation',
    wait: 'Wait',
    extract: 'Extract',
    http: 'HTTP',
    script: 'script',
    if: 'condition',
    foreach: 'loop',
    assert: 'assertion',
    key: 'keyboard',
    drag: 'drag',
    dblclick: 'Double click',
    openTab: 'open tab',
    switchTab: 'Switch tab',
    closeTab: 'Close tag',
    delay: 'delay',
    scroll: 'scroll',
    while: 'loop',
  };
  return labels[String(type || '')] || type || '';
}

export function nodeSubtitle(node?: NodeBase | null): string {
  if (!node) return '';
  const summary = summarize(node);
  if (!summary) return node.type || '';
  return summary.length > 40 ? `${summary.slice(0, 40)}...` : summary;
}
