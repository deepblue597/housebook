/** The tool preview for one floor, from the stores (see preview.ts). Empty outside edit mode. */
import { useMemo } from 'react';
import { useData } from '../../store/data';
import { applyContext, useEditor } from '../../store/editor';
import { type PreviewEdge, type PreviewRect, previewEdges, previewRects } from './preview';

export function usePreviewRects(floorId: string): PreviewRect[] {
  const mode = useEditor((s) => s.mode);
  const tool = useEditor((s) => s.tool);
  const gesture = useEditor((s) => s.gesture);
  const hover = useEditor((s) => s.hover);
  const place = useEditor((s) => s.place);
  const paintRoomId = useEditor((s) => s.paintRoomId);
  const model = useData((s) => s.model);
  return useMemo(() => {
    const layout = model?.snapshot.house;
    if (mode !== 'edit' || !layout) return [];
    return previewRects({
      floorId,
      layout,
      footprintOf: applyContext().footprintOf,
      tool,
      gesture,
      hover,
      place,
      paintColor: (paintRoomId && model.rooms.get(paintRoomId)?.color) || null,
    });
  }, [mode, tool, gesture, hover, place, paintRoomId, model, floorId]);
}

/** The wall edges a door, window or open wall would go on, for one floor (D36, D51). */
export function usePreviewEdges(floorId: string): PreviewEdge[] {
  const mode = useEditor((s) => s.mode);
  const tool = useEditor((s) => s.tool);
  const gesture = useEditor((s) => s.gesture);
  const hover = useEditor((s) => s.hover);
  const layout = useData((s) => s.model?.snapshot.house);
  return useMemo(() => {
    if (mode !== 'edit' || !layout) return [];
    return previewEdges({
      floorId,
      layout,
      footprintOf: applyContext().footprintOf,
      tool,
      gesture,
      hover,
      place: null,
      paintColor: null,
    });
  }, [mode, tool, gesture, hover, layout, floorId]);
}
