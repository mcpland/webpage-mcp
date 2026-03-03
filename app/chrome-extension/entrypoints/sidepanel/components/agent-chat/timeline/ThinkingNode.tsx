import { useMemo, useState } from 'react';
import { getMessage } from '@/utils/i18n';

import './ThinkingNode.css';

interface ThinkingNodeType {
  type: 'thinking';
  tag?: string;
  content: string;
  raw: string;
  loading?: boolean;
  autoClosed?: boolean;
  attrs?: Array<[string, string]>;
}

type ThinkingNodeProps = {
  node: ThinkingNodeType;
  loading?: boolean;
  indexKey?: string;
  customId?: string;
  isDark?: boolean;
  typewriter?: boolean;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatLine(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export default function ThinkingNode({ node, loading }: ThinkingNodeProps) {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);
  const [expanded, setExpanded] = useState(false);

  const isLoading = useMemo(() => loading ?? node.loading ?? false, [loading, node.loading]);

  const innerText = useMemo(() => {
    const rawSrc = String(node.raw ?? '');
    if (rawSrc) {
      const rawMatch = rawSrc.match(/<thinking\b[^>]*>([\s\S]*?)<\/thinking>/i);
      if (rawMatch) {
        return rawMatch[1].trim();
      }
    }

    const src = String(node.content ?? '');
    const match = src.match(/<thinking\b[^>]*>([\s\S]*?)<\/thinking>/i);
    if (match) {
      return match[1].trim();
    }

    return src
      .replace(/^<thinking\b[^>]*>/i, '')
      .replace(/<\/thinking>\s*$/i, '')
      .trim();
  }, [node.content, node.raw]);

  const lines = useMemo(() => innerText.split('\n').filter((line) => line.trim()), [innerText]);
  const firstLine = useMemo(
    () => (lines[0] ?? '').replace(/^\*\*/, '').replace(/\*\*$/, ''),
    [lines],
  );
  const restLines = useMemo(() => lines.slice(1), [lines]);
  const moreCount = restLines.length;
  const canExpand = !isLoading && moreCount > 0;

  return (
    <span className="thinking-section">
      <button
        type="button"
        className={`thinking-header${canExpand ? ' thinking-header--expandable' : ''}`}
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
        onClick={() => {
          if (canExpand) {
            setExpanded((current) => !current);
          }
        }}
      >
        <svg
          className="thinking-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>

        {isLoading ? (
          <span className="thinking-loading">
            <span className="thinking-pulse" aria-hidden="true" />
            {t('agentThinkingStatus', 'Thinking...')}
          </span>
        ) : (
          <>
            <span
              className="thinking-summary"
              dangerouslySetInnerHTML={{ __html: formatLine(firstLine) }}
            />
            {canExpand ? (
              <span className="thinking-toggle">
                <svg
                  className={expanded ? 'thinking-toggle--expanded' : undefined}
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                {t('agentMoreLinesCount', '{0} more {1}', [
                  String(moreCount),
                  moreCount === 1 ? t('agentLineWord', 'line') : t('agentLinesWord', 'lines'),
                ])}
              </span>
            ) : null}
          </>
        )}
      </button>

      {expanded && !isLoading && restLines.length > 0 ? (
        <span className="thinking-content">
          {restLines.map((line, idx) => (
            <span key={`${idx}-${line}`}>
              <span dangerouslySetInnerHTML={{ __html: formatLine(line) }} />
              {idx < restLines.length - 1 ? <br /> : null}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
