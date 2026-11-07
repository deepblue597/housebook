import { Suspense, lazy } from 'react';
import { useEditor } from '../../store/editor';

const EditorPanels = lazy(() => import('./EditorPanels'));

/** The editor's panels, loaded the first time edit mode is switched on. */
export function LazyEditorPanels() {
  const editing = useEditor((s) => s.mode === 'edit');
  if (!editing) return null;
  return (
    <Suspense fallback={null}>
      <EditorPanels />
    </Suspense>
  );
}
