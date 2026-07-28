import { useEffect, useMemo, useRef } from 'react';

import type { Locale, MessageKey } from '@lexianchor/i18n';
import type { WordCardRecord } from '@lexianchor/storage';

interface WordCardDetailDialogProps {
  readonly cards: readonly WordCardRecord[];
  readonly activeCardId: string | null;
  readonly locale: Locale;
  readonly t: (key: MessageKey) => string;
  readonly onActiveCardChange: (cardId: string) => void;
  readonly onClose: () => void;
}

export function WordCardDetailDialog({
  cards,
  activeCardId,
  locale,
  t,
  onActiveCardChange,
  onClose,
}: WordCardDetailDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeIndex = useMemo(
    () => cards.findIndex((card) => card.id === activeCardId),
    [activeCardId, cards],
  );

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (activeIndex < 0) {
      if (dialog.open) {
        dialog.close();
      }
      return;
    }

    const wasOpen = dialog.open;
    if (!wasOpen) {
      dialog.showModal();
    }

    const frame = requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }

      viewport.scrollTo({
        left: activeIndex * viewport.clientWidth,
        behavior:
          wasOpen && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
            ? 'smooth'
            : 'auto',
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [activeIndex]);

  useEffect(
    () => () => {
      if (scrollTimer.current !== null) {
        clearTimeout(scrollTimer.current);
      }
    },
    [],
  );

  if (activeIndex < 0) {
    return <dialog className="word-card-detail-dialog" ref={dialogRef} />;
  }

  const activeCard = cards[activeIndex];

  function navigateTo(index: number) {
    const nextCard = cards[index];
    if (nextCard) {
      onActiveCardChange(nextCard.id);
    }
  }

  function settleVisibleCard() {
    const viewport = viewportRef.current;
    if (!viewport || viewport.clientWidth <= 0) {
      return;
    }

    const nextIndex = Math.max(
      0,
      Math.min(cards.length - 1, Math.round(viewport.scrollLeft / viewport.clientWidth)),
    );
    const nextCard = cards[nextIndex];
    if (nextCard && nextCard.id !== activeCardId) {
      onActiveCardChange(nextCard.id);
    }
  }

  return (
    <dialog
      className="word-card-detail-dialog"
      ref={dialogRef}
      aria-labelledby="word-card-detail-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' && activeIndex > 0) {
          event.preventDefault();
          navigateTo(activeIndex - 1);
        } else if (event.key === 'ArrowRight' && activeIndex < cards.length - 1) {
          event.preventDefault();
          navigateTo(activeIndex + 1);
        }
      }}
    >
      <section className="word-card-detail-surface">
        <header className="word-card-detail-toolbar">
          <div>
            <p className="word-card-detail-position">
              {activeIndex + 1} {t('of')} {cards.length}
            </p>
            <h2 id="word-card-detail-title">{activeCard?.term}</h2>
          </div>
          <button type="button" onClick={onClose}>
            {t('closeCardDetails')}
          </button>
        </header>

        <div
          className="word-card-detail-viewport"
          ref={viewportRef}
          aria-label={t('cardDetails')}
          onScroll={() => {
            if (scrollTimer.current !== null) {
              clearTimeout(scrollTimer.current);
            }
            scrollTimer.current = setTimeout(settleVisibleCard, 100);
          }}
        >
          {cards.map((card, index) => (
            <article
              className="word-card-detail-page"
              data-detail-card-id={card.id}
              aria-hidden={index !== activeIndex}
              key={card.id}
            >
              <div className="word-card-detail-heading">
                <span className="badge">{card.partOfSpeech}</span>
                <h3>{card.term}</h3>
              </div>

              <section className="word-card-english-definition">
                <p>{t('englishDefinition')}</p>
                <ol>
                  {card.definitions.map((definition) => (
                    <li key={definition}>{definition}</li>
                  ))}
                </ol>
              </section>

              <dl className="word-card-metadata">
                <div>
                  <dt>{t('wordRoot')}</dt>
                  <dd>{card.rootOrEtymology ?? t('notProvided')}</dd>
                </div>
                <div>
                  <dt>{t('sourceBook')}</dt>
                  <dd>{card.sourceBookTitle}</dd>
                </div>
                <div>
                  <dt>{t('originalSentence')}</dt>
                  <dd>“{card.sourceSentence}”</dd>
                </div>
                <div>
                  <dt>{t('dictionarySource')}</dt>
                  <dd>{card.dictionarySource}</dd>
                </div>
                <div>
                  <dt>{t('createdAt')}</dt>
                  <dd>
                    {new Intl.DateTimeFormat(locale, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(card.createdAt))}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
        </div>

        <footer className="word-card-detail-footer">
          <button
            type="button"
            disabled={activeIndex === 0}
            onClick={() => navigateTo(activeIndex - 1)}
          >
            ← {t('previousCard')}
          </button>
          <p>{t('swipeCardHint')}</p>
          <button
            type="button"
            disabled={activeIndex === cards.length - 1}
            onClick={() => navigateTo(activeIndex + 1)}
          >
            {t('nextCard')} →
          </button>
        </footer>
      </section>
    </dialog>
  );
}
