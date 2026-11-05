import { type KeyboardEvent, useCallback, useMemo, useRef } from 'react';
import { useResolvedTheme } from '../../app/theme';
import { useData } from '../../store/data';
import type { FloorModel } from '../../store/model';
import { useSearchResults } from '../../store/search';
import { useUi } from '../../store/ui';
import { FloorTabs } from '../../components/FloorTabs';
import { planBounds } from './geometry';
import { PlanSvg } from './PlanSvg';
import { usePanZoom } from './usePanZoom';

export function PlanView({ floor }: { floor: FloorModel }) {
  const model = useData((s) => s.model)!;
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const search = useSearchResults();
  const theme = useResolvedTheme();
  const viewport = useRef<HTMLDivElement>(null);
  // Keyed on the numbers: every snapshot brings a new grid object, and a background refresh
  // must not refit (and lose) the user's zoom and pan.
  const { width, depth } = model.grid;
  const bounds = useMemo(() => planBounds({ width, depth }), [width, depth]);
  const { view, fit, zoomBy, handlers } = usePanZoom(viewport, bounds, floor.floor.id);

  const onItem = useCallback((id: string) => select({ kind: 'item', id }), [select]);
  const onRoom = useCallback(
    (roomId: string) => select({ kind: 'room', roomId, floorId: floor.floor.id }),
    [select, floor.floor.id],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === '+' || e.key === '=') zoomBy(1.25);
    else if (e.key === '-') zoomBy(0.8);
    else if (e.key === '0') fit();
  };

  return (
    <section className="stage" aria-label="Floor plan">
      <div className="floorbar">
        <FloorTabs floors={model.floors} current={floor.floor.id} />
        <div className="zoom" role="group" aria-label="Zoom">
          <button type="button" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
            −
          </button>
          <span aria-live="polite" aria-atomic="true">
            {Math.round(view.k * 100)}%
          </span>
          <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="fit" onClick={fit}>
            Fit
          </button>
        </div>
      </div>
      {/* The viewport is focusable so keyboard users can zoom with + / − / 0. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={viewport}
        className="viewport"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="region"
        aria-label={`Plan of ${floor.floor.name}. Drag to pan, scroll or pinch to zoom.`}
        onKeyDown={onKeyDown}
        {...handlers}
      >
        <svg className="plan" role="group" aria-label={`${floor.floor.name} plan`}>
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
            <PlanSvg
              model={model}
              floor={floor}
              theme={theme}
              selectedItemId={selection?.kind === 'item' ? selection.id : null}
              selectedRoomId={
                selection?.kind === 'room' && selection.floorId === floor.floor.id
                  ? selection.roomId
                  : null
              }
              matches={search.active ? search.matches : null}
              onItem={onItem}
              onRoom={onRoom}
            />
          </g>
        </svg>
      </div>
    </section>
  );
}
