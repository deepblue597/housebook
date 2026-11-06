import { Component, Suspense, lazy } from 'react';
import type { MarkdownBodyProps } from './MarkdownBody';

import { loadMarkdown, markdownLoaded } from './markdownLoader';

// React.lazy keeps a failed import forever; after a failure a fresh one retries the chunk on
// the next render (another note opened, or the same note changed).
let MarkdownBody = lazy(loadMarkdown);

/** Until the renderer has loaded (or if it fails), the note is shown as plain text. */
const Plain = ({ body }: { body: string }) => <div className="md-plain">{body}</div>;

/** Chromium, Firefox and Safari wording for a failed `import()`. */
const isChunkError = (e: unknown) =>
  /dynamically imported module|importing a module script failed/i.test(
    e instanceof Error ? e.message : String(e),
  );

interface FallbackState {
  failed: boolean;
  body: string;
  /** Retried the chunk once since the last body change (no retry loop). */
  retried: boolean;
}

/**
 * Renders the lazy renderer itself (not `children`), so after a failed chunk load the next
 * render uses the fresh lazy component.
 */
class Renderer extends Component<MarkdownBodyProps, FallbackState> {
  override state: FallbackState = { failed: false, body: this.props.body, retried: false };
  private mounted = false;
  static getDerivedStateFromError(): Partial<FallbackState> {
    return { failed: true };
  }
  static getDerivedStateFromProps(
    props: MarkdownBodyProps,
    state: FallbackState,
  ): Partial<FallbackState> | null {
    // A different note: try the renderer again.
    return props.body !== state.body ? { failed: false, body: props.body, retried: false } : null;
  }
  override componentDidMount() {
    this.mounted = true;
  }
  override componentWillUnmount() {
    this.mounted = false;
  }
  override componentDidCatch(error: unknown) {
    // Only a failed chunk load is retried (a render error would just fail again): once now, in
    // case the network is already back, and again whenever another note is shown.
    if (this.state.retried || (markdownLoaded() && !isChunkError(error))) return;
    MarkdownBody = lazy(loadMarkdown);
    loadMarkdown().then(
      () => {
        if (this.mounted) this.setState({ failed: false, retried: true });
      },
      () => undefined,
    );
  }
  override render() {
    if (this.state.failed) return <Plain body={this.props.body} />;
    return (
      <Suspense fallback={<Plain body={this.props.body} />}>
        <MarkdownBody {...this.props} />
      </Suspense>
    );
  }
}

export function Notes(props: MarkdownBodyProps) {
  if (!props.body.trim()) return <p className="muted">No notes yet.</p>;
  return (
    <div className="md">
      <Renderer {...props} />
    </div>
  );
}
