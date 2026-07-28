import { useCallback, useEffect, useRef, useState } from 'react';

const fullscreenToolbarStorageKey = 'lexianchor:fullscreen-toolbar-auto-hide';

function readAutoHidePreference(): boolean {
  return globalThis.localStorage?.getItem(fullscreenToolbarStorageKey) !== 'false';
}

export function useFullscreenToolbar(isFullscreen: boolean) {
  const [autoHide, setAutoHideState] = useState(readAutoHidePreference);
  const [isToolbarVisible, setIsToolbarVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      globalThis.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(
    (delay = 1100) => {
      clearHideTimer();
      if (!isFullscreen || !autoHide) {
        setIsToolbarVisible(true);
        return;
      }

      hideTimerRef.current = globalThis.setTimeout(() => {
        hideTimerRef.current = null;
        setIsToolbarVisible(false);
      }, delay);
    },
    [autoHide, clearHideTimer, isFullscreen],
  );

  const revealToolbar = useCallback(() => {
    setIsToolbarVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  const setAutoHide = useCallback((enabled: boolean) => {
    setAutoHideState(enabled);
    globalThis.localStorage?.setItem(fullscreenToolbarStorageKey, String(enabled));
  }, []);

  useEffect(() => {
    if (!isFullscreen || !autoHide) {
      clearHideTimer();
      return;
    }

    const revealFrame = requestAnimationFrame(() => {
      setIsToolbarVisible(true);
      scheduleHide(1500);
    });

    const handlePointerMove = (event: PointerEvent) => {
      if (event.clientY <= 80) {
        revealToolbar();
      } else if (event.clientY > 108) {
        scheduleHide(700);
      }
    };
    const handleKeyboardFocus = (event: FocusEvent) => {
      if ((event.target as Element | null)?.closest('.reader-toolbar')) {
        clearHideTimer();
        setIsToolbarVisible(true);
      }
    };

    globalThis.addEventListener('pointermove', handlePointerMove, { passive: true });
    globalThis.addEventListener('focusin', handleKeyboardFocus);

    return () => {
      globalThis.removeEventListener('pointermove', handlePointerMove);
      globalThis.removeEventListener('focusin', handleKeyboardFocus);
      cancelAnimationFrame(revealFrame);
      clearHideTimer();
    };
  }, [autoHide, clearHideTimer, isFullscreen, revealToolbar, scheduleHide]);

  return {
    autoHide,
    isToolbarVisible: !isFullscreen || !autoHide || isToolbarVisible,
    revealToolbar,
    scheduleHide,
    setAutoHide,
  };
}
