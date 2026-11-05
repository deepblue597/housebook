/**
 * Where the 3D view mounts (lazy, see scene3d.ts). A failed chunk load or a crash in the scene
 * falls back to the 2D plan with a "try again" banner instead of a blank stage.
 */
import { Component, type ReactNode, Suspense, use } from 'react';
import type { FloorModel } from '../store/model';
import { useUi } from '../store/ui';
import { loadScene3d } from './scene3d';

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    console.error('3D view failed', error);
    useUi.getState().setScene3dIssue('load_failed');
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

function Scene3d({ floor }: { floor: FloorModel }) {
  const { default: View } = use(loadScene3d());
  return <View floor={floor} />;
}

export function Scene3dSlot({ floor }: { floor: FloorModel }) {
  return (
    <SceneBoundary>
      <Suspense
        fallback={
          <section className="stage state" aria-busy="true">
            <p role="status">Loading the 3D view…</p>
          </section>
        }
      >
        <Scene3d floor={floor} />
      </Suspense>
    </SceneBoundary>
  );
}
