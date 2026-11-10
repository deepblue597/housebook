/**
 * Keyboard shortcuts in edit mode (DESIGN 15.12): Ctrl/⌘+Z undo, Ctrl/⌘+Shift+Z or Ctrl+Y redo,
 * V/B/E/D/W tools, R rotates and Delete removes the selected item from the plan, Esc cancels the
 * gesture or the armed tool. Ignored while typing in a field or with a dialog open.
 */
import { useEffect } from 'react';
import { useEditor } from '../../store/editor';
import { useUi } from '../../store/ui';

const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || !!t.closest('input, textarea, select, [contenteditable="true"]'));

export function useEditorShortcuts(): void {
  const mode = useEditor((s) => s.mode);
  useEffect(() => {
    if (mode !== 'edit') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target) || document.querySelector('dialog[open]')) return;
      const ed = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const sel = useUi.getState().selection;
      const selectedId = sel?.kind === 'item' ? sel.id : null;
      let handled = true;
      if (mod && key === 'z' && !e.shiftKey) ed.undoLast();
      else if (mod && ((key === 'z' && e.shiftKey) || key === 'y')) ed.redoLast();
      else if (mod || e.altKey) handled = false;
      else if (key === 'v') ed.setTool('select');
      else if (key === 'b') ed.setTool('paint');
      else if (key === 'e') ed.setTool('erase');
      else if (key === 'd') ed.setTool('door');
      else if (key === 'w') ed.setTool('window');
      else if (key === 'r' && selectedId) ed.rotateItem(selectedId);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId)
        ed.unplaceItem(selectedId);
      else if (e.key === 'Escape' && (ed.gesture || ed.tool !== 'select')) ed.cancel();
      else handled = false;
      if (handled) e.preventDefault();
    };
    // Capture: runs before the details panel's Esc (which checks defaultPrevented).
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode]);
}
