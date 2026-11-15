/** Edit mode on the 2D plan: the grid's outline and the active tool's preview (see editor). */
import { usePreviewEdges, usePreviewRects } from '../editor';
import { useEditor } from '../../store/editor';
import { S } from './geometry';

export function EditOverlay({
  floorId,
  grid,
}: {
  floorId: string;
  grid: { width: number; depth: number };
}) {
  const editing = useEditor((s) => s.mode === 'edit');
  const rects = usePreviewRects(floorId);
  const edges = usePreviewEdges(floorId);
  if (!editing) return null;
  return (
    <g className="edit-overlay" aria-hidden="true" pointerEvents="none">
      <rect className="edit-bounds" x={0} y={0} width={grid.width * S} height={grid.depth * S} />
      {rects.map((p, i) => (
        <g key={i} data-preview={p.tone}>
          <rect
            className={`edit-${p.tone}`}
            x={p.rect.x * S}
            y={p.rect.y * S}
            width={p.rect.w * S}
            height={p.rect.h * S}
            style={p.color ? { fill: p.color } : undefined}
          />
          {(p.tone === 'paint' || p.tone === 'erase') && (p.rect.w > 1 || p.rect.h > 1) && (
            <text className="edit-size" x={(p.rect.x + p.rect.w) * S - 4} y={p.rect.y * S - 5}>
              {`${p.rect.w} × ${p.rect.h}`}
            </text>
          )}
        </g>
      ))}
      {edges.map(({ edge, kind, ok }) => (
        <line
          key={`${edge.x},${edge.y},${edge.side}`}
          className={`edit-edge${ok ? '' : ' bad'}`}
          data-preview={ok ? kind : 'not-a-wall'}
          x1={edge.x * S}
          y1={edge.y * S}
          x2={(edge.x + (edge.side === 'n' ? 1 : 0)) * S}
          y2={(edge.y + (edge.side === 'w' ? 1 : 0)) * S}
        />
      ))}
    </g>
  );
}
