interface ReaderFooterProps {
  readonly currentPage: number | undefined;
  readonly totalPages: number | undefined;
  readonly pagesRemaining: number | undefined;
  readonly backLabel: string | undefined;
  readonly pagesRemainingLabel: string;
  readonly ofLabel: string;
  readonly onBack: (() => void) | undefined;
}

export function ReaderFooter({
  currentPage,
  totalPages,
  pagesRemaining,
  backLabel,
  pagesRemainingLabel,
  ofLabel,
  onBack,
}: ReaderFooterProps) {
  return (
    <footer
      className="reader-footer"
      aria-label={`${currentPage ?? '—'} ${ofLabel} ${totalPages ?? '—'}`}
    >
      <div className="reader-footer-leading">
        {onBack ? (
          <button type="button" onClick={onBack}>
            ← {backLabel}
          </button>
        ) : null}
      </div>
      <output className="reader-footer-page">
        {currentPage ?? '—'} {ofLabel} {totalPages ?? '—'}
      </output>
      <span className="reader-footer-trailing">
        {pagesRemaining === undefined ? '' : `${pagesRemaining} ${pagesRemainingLabel}`}
      </span>
    </footer>
  );
}
