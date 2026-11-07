/**
 * Edit mode's panels as one lazy chunk (DESIGN 15.10: viewers never download them): the side
 * bar, the resize dialog and the new-item dialog.
 */
import { useState } from 'react';
import { EditorSidebar } from './EditorSidebar';
import { NewItemDialog } from './NewItemDialog';
import { ResizeDialog } from './ResizeDialog';

export default function EditorPanels() {
  const [resizing, setResizing] = useState(false);
  return (
    <>
      <EditorSidebar onResize={() => setResizing(true)} />
      <NewItemDialog />
      {resizing && <ResizeDialog onClose={() => setResizing(false)} />}
    </>
  );
}
