import type { CSSProperties } from 'react';

import type { DictionaryProvider } from '@lexianchor/dictionary';
import type { Locale, MessageKey } from '@lexianchor/i18n';
import type { ReaderSelection } from '@lexianchor/reader-core';
import type {
  BergamotTranslationProvider,
  TranslationTargetLanguage,
} from '@lexianchor/translation';

import { SelectionTools, type WordCardDraft } from './selection-tools';

interface FloatingSelectionToolsProps {
  readonly selection: ReaderSelection;
  readonly locale: Locale;
  readonly t: (key: MessageKey) => string;
  readonly onDismiss: () => void;
  readonly onOpenExternal: (url: string) => Promise<void>;
  readonly onAddWordCard: (draft: WordCardDraft) => Promise<void>;
  readonly providers: readonly DictionaryProvider[];
  readonly localTranslationProvider: BergamotTranslationProvider;
  readonly installedTranslationTargets: readonly TranslationTargetLanguage[];
}

function floatingStyle(selection: ReaderSelection): CSSProperties {
  const anchor = selection.anchorRect;

  if (!anchor) {
    return { left: '50%', bottom: 18, transform: 'translateX(-50%)' };
  }

  const viewportWidth = globalThis.innerWidth || 1024;
  const viewportHeight = globalThis.innerHeight || 768;
  const left = Math.min(viewportWidth - 184, Math.max(184, (anchor.left + anchor.right) / 2));
  const placeBelow = anchor.bottom + 340 < viewportHeight;

  return {
    left,
    top: placeBelow ? anchor.bottom + 12 : Math.max(12, anchor.top - 12),
    transform: placeBelow ? 'translateX(-50%)' : 'translate(-50%, -100%)',
  };
}

export function FloatingSelectionTools({
  selection,
  locale,
  t,
  onDismiss,
  onOpenExternal,
  onAddWordCard,
  providers,
  localTranslationProvider,
  installedTranslationTargets,
}: FloatingSelectionToolsProps) {
  return (
    <div
      className="selection-popover-shell"
      style={floatingStyle(selection)}
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
      />
    </div>
  );
}
