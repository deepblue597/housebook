import { Component, type ReactNode, Suspense, lazy } from 'react';
import type { MarkdownBodyProps } from './MarkdownBody';

import { loadMarkdown } from './markdownLoader';

const MarkdownBody = lazy(loadMarkdown);

/** Until the renderer has loaded (or if it fails), the note is shown as plain text. */
const Plain = ({ body }: { body: string }) => <div className="md-plain">{body}</div>;

class Fallback extends Component<{ body: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <Plain body={this.props.body} /> : this.props.children;
  }
}

export function Notes(props: MarkdownBodyProps) {
  if (!props.body.trim()) return <p className="muted">No notes yet.</p>;
  return (
    <div className="md">
      <Fallback body={props.body}>
        <Suspense fallback={<Plain body={props.body} />}>
          <MarkdownBody {...props} />
        </Suspense>
      </Fallback>
    </div>
  );
}
