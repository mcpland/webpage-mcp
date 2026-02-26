import { useEffect, useMemo, useRef, useState } from 'react';

import type { TimelineItem } from '../../../composables/useAgentThreads';
import { getRandomLoadingText } from '../../../utils/loading-texts';

type TimelineStatusStepProps = {
  item: Extract<TimelineItem, { kind: 'status' }>;
  hideIcon?: boolean;
};

export default function TimelineStatusStep({ item, hideIcon }: TimelineStatusStepProps) {
  const [randomText, setRandomText] = useState(getRandomLoadingText());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isRunning = item.status === 'running' || item.status === 'starting';

  const defaultText = useMemo(() => {
    switch (item.status) {
      case 'completed':
        return 'Done';
      case 'error':
        return 'Error';
      case 'cancelled':
        return 'Cancelled';
      default:
        return 'Ready';
    }
  }, [item.status]);

  const displayText = isRunning ? randomText : item.text || defaultText;

  useEffect(() => {
    if (!isRunning) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    setRandomText(getRandomLoadingText());

    const scheduleNext = () => {
      timerRef.current = setTimeout(
        () => {
          setRandomText(getRandomLoadingText());
          scheduleNext();
        },
        5000 + Math.random() * 3000,
      );
    };

    scheduleNext();

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isRunning]);

  return (
    <div className="flex items-center gap-2">
      {isRunning && !hideIcon ? (
        <svg className="loading-scribble w-4 h-4 flex-shrink-0" viewBox="0 0 100 100" fill="none">
          <path
            d="M50 50 C50 48, 52 46, 54 46 C58 46, 60 50, 60 54 C60 60, 54 64, 48 64 C40 64, 36 56, 36 48 C36 38, 44 32, 54 32 C66 32, 74 42, 74 54 C74 68, 62 78, 48 78 C32 78, 22 64, 22 48 C22 30, 36 18, 54 18 C74 18, 88 34, 88 54 C88 76, 72 92, 50 92"
            stroke="var(--ac-accent, #D97757)"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      ) : null}

      <span
        className={`text-xs italic${isRunning ? ' text-shimmer' : ''}`}
        style={{ color: isRunning ? undefined : 'var(--ac-text-muted)' }}
      >
        {displayText}
      </span>
    </div>
  );
}
