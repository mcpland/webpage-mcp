import { useEffect, useMemo, useRef, useState } from 'react';

import {
  installFloatingDrag,
  type FloatingPosition,
} from '@/entrypoints/web-editor-v2/ui/floating-drag';
import { getMessage } from '@/utils/i18n';
import './SidepanelNavigator.css';

export type SidepanelTabType = 'workflows' | 'element-markers';

export type SidepanelNavigatorProps = {
  activeTab: SidepanelTabType;
  onChange: (tab: SidepanelTabType) => void;
};

const STORAGE_KEY = 'sidepanel_navigator_position';
const BUTTON_SIZE = 36;
const CLAMP_MARGIN = 12;

function getDefaultPosition(): FloatingPosition {
  return {
    left: window.innerWidth - BUTTON_SIZE - CLAMP_MARGIN,
    top: window.innerHeight - BUTTON_SIZE - CLAMP_MARGIN,
  };
}

function clampPosition(position: FloatingPosition): FloatingPosition {
  const maxLeft = Math.max(CLAMP_MARGIN, window.innerWidth - BUTTON_SIZE - CLAMP_MARGIN);
  const maxTop = Math.max(CLAMP_MARGIN, window.innerHeight - BUTTON_SIZE - CLAMP_MARGIN);
  return {
    left: Math.min(Math.max(CLAMP_MARGIN, position.left), maxLeft),
    top: Math.min(Math.max(CLAMP_MARGIN, position.top), maxTop),
  };
}

async function loadPosition(): Promise<FloatingPosition | null> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const saved = result[STORAGE_KEY];
    if (
      saved &&
      typeof saved.left === 'number' &&
      typeof saved.top === 'number' &&
      Number.isFinite(saved.left) &&
      Number.isFinite(saved.top)
    ) {
      return saved as FloatingPosition;
    }
  } catch (error) {
    console.warn('Failed to load navigator position:', error);
  }
  return null;
}

async function savePosition(position: FloatingPosition): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: position });
  } catch (error) {
    console.warn('Failed to save navigator position:', error);
  }
}

export default function SidepanelNavigator({ activeTab, onChange }: SidepanelNavigatorProps) {
  const t = (key: string, fallback: string): string => getMessage(key, undefined, fallback);
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [position, setPosition] = useState<FloatingPosition>(() => getDefaultPosition());

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const wrapperStyle = useMemo(
    () => ({
      left: `${position.left}px`,
      top: `${position.top}px`,
    }),
    [position.left, position.top],
  );

  function closeMenu(): void {
    setIsOpen(false);
  }

  function handleTriggerClick(): void {
    if (!isDragging) {
      setIsOpen((current) => !current);
    }
  }

  function resetToDefault(): void {
    const next = getDefaultPosition();
    setPosition(next);
    void savePosition(next);
  }

  function selectTab(tab: SidepanelTabType): void {
    onChange(tab);
    closeMenu();
  }

  useEffect(() => {
    void (async () => {
      const saved = await loadPosition();
      if (saved) {
        setPosition(clampPosition(saved));
      } else {
        setPosition(getDefaultPosition());
      }
    })();
  }, []);

  useEffect(() => {
    if (!triggerRef.current || !wrapperRef.current) {
      return;
    }

    const cleanupDrag = installFloatingDrag({
      handleEl: triggerRef.current,
      targetEl: wrapperRef.current,
      onPositionChange: (next) => {
        setPosition(next);
        void savePosition(next);
      },
      clampMargin: CLAMP_MARGIN,
      clickThresholdMs: 150,
      moveThresholdPx: 5,
    });

    const observer = new MutationObserver(() => {
      setIsDragging(triggerRef.current?.dataset.dragging === 'true');
    });

    observer.observe(triggerRef.current, {
      attributes: true,
      attributeFilter: ['data-dragging'],
    });

    return () => {
      cleanupDrag();
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      className={`navigator-wrapper${isDragging ? ' navigator-dragging' : ''}`}
      style={wrapperStyle}
    >
      <button
        ref={triggerRef}
        className={`navigator-trigger${isOpen ? ' navigator-trigger-active' : ''}`}
        onClick={handleTriggerClick}
        onDoubleClick={resetToDefault}
        title={t(
          'sidepanelNavigatorToggleTitle',
          'Switch pages (drag to move, double-click to reset position)',
        )}
        type="button"
      >
        <svg
          className="navigator-icon"
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {isOpen ? (
        <div className="navigator-overlay" onClick={closeMenu}>
          <div className="navigator-menu" onClick={(event) => event.stopPropagation()}>
            <div className="navigator-header">
              <span className="navigator-title">
                {t('sidepanelNavigatorTitle', 'Switch pages')}
              </span>
              <button className="navigator-close" onClick={closeMenu} type="button">
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="navigator-items">
              <button
                className={`navigator-item${activeTab === 'workflows' ? ' navigator-item-active' : ''}`}
                onClick={() => selectTab('workflows')}
                type="button"
              >
                <div className="navigator-item-icon">
                  <svg
                    viewBox="0 0 24 24"
                    width="20"
                    height="20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
                    />
                  </svg>
                </div>
                <div className="navigator-item-content">
                  <span className="navigator-item-title">
                    {t('sidepanelNavigatorWorkflowsTitle', 'Workflow management')}
                  </span>
                  <span className="navigator-item-desc">
                    {t(
                      'sidepanelNavigatorWorkflowsDesc',
                      'Record and replay automation workflows',
                    )}
                  </span>
                </div>
                {activeTab === 'workflows' ? (
                  <div className="navigator-item-check">
                    <svg
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                ) : null}
              </button>

              <button
                className={`navigator-item${activeTab === 'element-markers' ? ' navigator-item-active' : ''}`}
                onClick={() => selectTab('element-markers')}
                type="button"
              >
                <div className="navigator-item-icon">
                  <svg
                    viewBox="0 0 24 24"
                    width="20"
                    height="20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                    />
                  </svg>
                </div>
                <div className="navigator-item-content">
                  <span className="navigator-item-title">
                    {t(
                      'sidepanelNavigatorElementMarkersTitle',
                      'Element annotation management',
                    )}
                  </span>
                  <span className="navigator-item-desc">
                    {t(
                      'sidepanelNavigatorElementMarkersDesc',
                      'Manage page element annotations',
                    )}
                  </span>
                </div>
                {activeTab === 'element-markers' ? (
                  <div className="navigator-item-check">
                    <svg
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                ) : null}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
