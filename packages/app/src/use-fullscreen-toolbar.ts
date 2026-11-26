import { useCallback, useEffect, useRef, useState } from 'react';

const fullscreenToolbarStorageKey = 'lexianchor:fullscreen-toolbar-auto-hide';

function readAutoHidePreference(): boolean {
  return globalThis.localStorage?.getItem(fullscreenToolbarStorageKey) !== 'false';
}

export function useFullscreenToolbar(isFullscreen: boolean) {
  const [autoHide, setAutoHideState] = useState(readAutoHidePreference);
  const [visibility, setVisibility] = useState<'visible' | 'hidden' | 'dismissed'>('visible');
  const introTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoHideActive = useRef(false);

  const revealToolbar = useCallback(() => {
    globalThis.clearTimeout(introTimer.current);
    setVisibility('visible');
  }, []);

  const hideToolbar = useCallback(() => {
    if (!autoHideActive.current) return;
    globalThis.clearTimeout(introTimer.current);
    setVisibility((current) => (current === 'dismissed' ? current : 'hidden'));
  }, []);

  const dismissToolbar = useCallback(() => {
    if (!autoHideActive.current) return;
    globalThis.clearTimeout(introTimer.current);
    setVisibility('dismissed');
  }, []);

  const setAutoHide = useCallback((enabled: boolean) => {
    setAutoHideState(enabled);
    setVisibility(enabled ? 'hidden' : 'visible');
    globalThis.localStorage?.setItem(fullscreenToolbarStorageKey, String(enabled));
  }, []);

  useEffect(() => {
    if (!isFullscreen || !autoHide) return;

    autoHideActive.current = true;
    introTimer.current = globalThis.setTimeout(hideToolbar, 450);

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && event.buttons === 0 && event.clientY <= 16) {
        revealToolbar();
      }
    };
    const handleKeyboardFocus = (event: FocusEvent) => {
      if (
        event.target instanceof Element &&
        event.target.matches(':focus-visible') &&
        event.target.closest('.reader-toolbar')
      ) {
        revealToolbar();
      }
    };

    globalThis.addEventListener('pointermove', handlePointerMove, { passive: true });
    globalThis.addEventListener('focusin', handleKeyboardFocus);

    return () => {
      autoHideActive.current = false;
      globalThis.removeEventListener('pointermove', handlePointerMove);
      globalThis.removeEventListener('focusin', handleKeyboardFocus);
      globalThis.clearTimeout(introTimer.current);
    };
  }, [autoHide, hideToolbar, isFullscreen, revealToolbar]);

  const toolbarVisibilityClass =
    isFullscreen && autoHide && (visibility === 'hidden' || visibility === 'dismissed')
      ? ` reader-page--toolbar-hidden${visibility === 'dismissed' ? ' reader-page--toolbar-dismissed' : ''}`
      : '';

  return {
    autoHide,
    toolbarVisibilityClass,
    revealToolbar,
    hideToolbar,
    dismissToolbar,
    setAutoHide,
  };
}
