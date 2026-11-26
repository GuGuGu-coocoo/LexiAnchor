interface ReaderFooterProps {
  readonly currentPage: number | undefined;
  readonly totalPages: number | undefined;
  readonly pageStatus?: string;
  readonly pagesRemaining: number | undefined;
  readonly backLabel: string | undefined;
  readonly pagesRemainingLabel: string;
  readonly onBack: (() => void) | undefined;
}

export function ReaderFooter({
  currentPage,
  totalPages,
  pageStatus,
  pagesRemaining,
  backLabel,
  pagesRemainingLabel,
  onBack,
}: ReaderFooterProps) {
  const pagePosition = pageStatus ?? `${currentPage ?? '—'} / ${totalPages ?? '—'}`;
  return (
    <footer className="reader-footer" aria-label={pagePosition}>
      <div className="reader-footer-leading">
        {onBack ? (
          <button type="button" onClick={onBack}>
            ← {backLabel}
          </button>
        ) : null}
      </div>
      <output className="reader-footer-page">{pagePosition}</output>
      <span className="reader-footer-trailing">
        {pagesRemaining === undefined ? '' : `${pagesRemaining} ${pagesRemainingLabel}`}
      </span>
    </footer>
  );
}
