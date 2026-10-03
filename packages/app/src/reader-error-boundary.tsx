import { Component, type ReactNode } from 'react';

interface ReaderErrorBoundaryProps {
  readonly children: ReactNode;
  readonly title: string;
  readonly instructions: string;
  readonly dataNotice: string;
  readonly returnLabel: string;
  readonly onReturnToLibrary: () => void;
}

interface ReaderErrorBoundaryState {
  readonly failed: boolean;
}

// Suspense covers a pending lazy import, not a rejected import or render.
// Do not retry React.lazy's cached rejected Promise; offer a safe way out.
export class ReaderErrorBoundary extends Component<
  ReaderErrorBoundaryProps,
  ReaderErrorBoundaryState
> {
  override state: ReaderErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ReaderErrorBoundaryState {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;

    return (
      <section className="reader-error" role="alert" data-testid="reader-unavailable">
        <strong>{this.props.title}</strong>
        <p>{this.props.instructions}</p>
        <p>{this.props.dataNotice}</p>
        <button type="button" onClick={this.props.onReturnToLibrary}>
          {this.props.returnLabel}
        </button>
      </section>
    );
  }
}
