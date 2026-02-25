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
    trigger: '触发器',
    click: '点击',
    fill: '填充',
    navigate: '导航',
    wait: '等待',
    extract: '提取',
    http: 'HTTP',
    script: '脚本',
    if: '条件',
    foreach: '循环',
    assert: '断言',
    key: '键盘',
    drag: '拖拽',
    dblclick: '双击',
    openTab: '打开标签',
    switchTab: '切换标签',
    closeTab: '关闭标签',
    delay: '延迟',
    scroll: '滚动',
    while: '循环',
  };
  return labels[String(type || '')] || type || '';
}

export function nodeSubtitle(node?: NodeBase | null): string {
  if (!node) return '';
  const summary = summarize(node);
  if (!summary) return node.type || '';
  return summary.length > 40 ? `${summary.slice(0, 40)}...` : summary;
}
