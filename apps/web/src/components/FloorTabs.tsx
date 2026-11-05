/** Floor switcher shared by the 2D plan and the 3D view, with per-floor search match counts. */
import type { FloorModel } from '../store/model';
import { useSearchResults } from '../store/search';
import { useUi } from '../store/ui';

export function FloorTabs({ floors, current }: { floors: FloorModel[]; current: string }) {
  const setFloor = useUi((s) => s.setFloor);
  const search = useSearchResults();
  return (
    <div className="floor-tabs" role="group" aria-label="Floors">
      {floors.map(({ floor }) => {
        const n = search.perFloor.get(floor.id) ?? 0;
        return (
          <button
            key={floor.id}
            type="button"
            className={`tab${floor.id === current ? ' on' : ''}`}
            aria-pressed={floor.id === current}
            onClick={() => setFloor(floor.id)}
          >
            {floor.name}
            {search.active && n > 0 && (
              <span className="cnt" aria-label={`, ${n} ${n === 1 ? 'match' : 'matches'}`}>
                {n}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
