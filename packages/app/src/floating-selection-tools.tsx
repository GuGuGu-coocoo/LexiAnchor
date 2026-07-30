import type { CSSProperties } from 'react';

import type { DictionaryProvider } from '@lexianchor/dictionary';
import type { Locale, MessageKey } from '@lexianchor/i18n';
import type { ReaderSelection } from '@lexianchor/reader-core';
import type {
  BergamotTranslationProvider,
  TranslationTargetLanguage,
} from '@lexianchor/translation';

import {
  SelectionTools,
  type OnlineTranslationProvider,
  type WordCardDraft,
} from './selection-tools';

interface FloatingSelectionToolsProps {
  readonly selection: ReaderSelection;
  readonly popoverWidth: number;
  readonly popoverHeight: number;
  readonly locale: Locale;
  readonly t: (key: MessageKey) => string;
  readonly onDismiss: () => void;
  readonly onOpenExternal: (url: string) => Promise<void>;
  readonly onAddWordCard: (draft: WordCardDraft) => Promise<void>;
  readonly providers: readonly DictionaryProvider[];
  readonly localTranslationProvider: BergamotTranslationProvider;
  readonly installedTranslationTargets: readonly TranslationTargetLanguage[];
  readonly onlineTranslationProvider: OnlineTranslationProvider;
}

function floatingStyle(
  selection: ReaderSelection,
  preferredWidth: number,
  preferredHeight: number,
): CSSProperties {
  const anchor = selection.anchorRect;

  if (!anchor) {
    return { left: '50%', bottom: 18, transform: 'translateX(-50%)' };
  }

  const viewportWidth = globalThis.innerWidth || 1024;
  const viewportHeight = globalThis.innerHeight || 768;
  const popoverWidth = Math.min(preferredWidth, viewportWidth - 24);
  const halfWidth = popoverWidth / 2;
  const left = Math.min(
    viewportWidth - 12 - halfWidth,
    Math.max(12 + halfWidth, (anchor.left + anchor.right) / 2),
  );
  const safeTop = Math.min(76, viewportHeight / 4);
  const maximumPopoverHeight = Math.min(
    preferredHeight,
    Math.max(1, viewportHeight - safeTop - 12),
  );
  const placeBelow = anchor.bottom + maximumPopoverHeight + 12 <= viewportHeight;

  return {
    '--selection-popover-max-height': `${maximumPopoverHeight}px`,
    '--selection-popover-width': `${popoverWidth}px`,
    left,
    top: placeBelow
      ? anchor.bottom + 12
      : Math.min(viewportHeight - 12, Math.max(safeTop + maximumPopoverHeight, anchor.top - 12)),
    transform: placeBelow ? 'translateX(-50%)' : 'translate(-50%, -100%)',
  } as CSSProperties;
}

export function FloatingSelectionTools({
  selection,
  popoverWidth,
  popoverHeight,
  locale,
  t,
  onDismiss,
  onOpenExternal,
  onAddWordCard,
  providers,
  localTranslationProvider,
  installedTranslationTargets,
  onlineTranslationProvider,
}: FloatingSelectionToolsProps) {
  return (
    <div
      className="selection-popover-shell"
      style={floatingStyle(selection, popoverWidth, popoverHeight)}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      <SelectionTools
        key={selection.text}
        selection={selection}
        emptyHint=""
        compact
        locale={locale}
        t={t}
        onDismiss={onDismiss}
        onOpenExternal={onOpenExternal}
        onAddWordCard={onAddWordCard}
        providers={providers}
        localTranslationProvider={localTranslationProvider}
        installedTranslationTargets={installedTranslationTargets}
        onlineTranslationProvider={onlineTranslationProvider}
      />
    </div>
  );
}
