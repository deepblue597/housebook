/**
 * A room's floor and wall finish (D41), from the room list. Every choice is an editor command
 * (undo, autosave); "copy to other rooms" is one step for all of them.
 */
import { useEffect, useRef, useState } from 'react';
import {
  EXTERIOR_DEFAULT,
  type Finish,
  floorFinish,
  floorFinishes,
  paintPalette,
  wallFinish,
  wallpaperFinishes,
} from '../../catalog/finishes';
import { Dialog } from '../../components/Dialog';
import { roomFloors } from '../../domain/layout';
import { EDITOR } from '../../strings/editor';
import { useData } from '../../store/data';
import { useEditor } from '../../store/editor';
import { useUi } from '../../store/ui';

/**
 * A colour input that commits when the picker closes (the native `change` event), not on every
 * move like React's onChange, so one pick is one undo step.
 */
function ColorPick({
  value,
  label,
  onPick,
}: {
  value: string;
  label: string;
  onPick: (color: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const commit = () => pick.current(el.value);
    el.addEventListener('change', commit);
    return () => el.removeEventListener('change', commit);
  }, []);
  return <input ref={ref} type="color" defaultValue={value} key={value} aria-label={label} />;
}

function Swatch({
  color,
  label,
  pressed,
  onClick,
}: {
  color: string | null;
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="swatch-btn"
      aria-pressed={pressed}
      onClick={onClick}
      title={label}
    >
      <span
        className={`swatch${color ? '' : ' none'}`}
        style={color ? { background: color } : undefined}
        aria-hidden="true"
      />
      {label}
    </button>
  );
}

const byGroup = (list: readonly Finish[]) => {
  const groups = new Map<string, Finish[]>();
  for (const f of list) {
    const g = f.group ?? '';
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  return [...groups];
};

export function FinishDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const house = useData((s) => s.model?.snapshot.house);
  const setRoomFinish = useEditor((s) => s.setRoomFinish);
  const copyFinish = useEditor((s) => s.copyFinish);
  const setExterior = useEditor((s) => s.setExteriorWallColor);
  const look = useUi((s) => s.look);
  const setLook = useUi((s) => s.setLook);
  const [copyTo, setCopyTo] = useState<ReadonlySet<string>>(new Set());

  const rooms = house?.rooms ?? [];
  const room = rooms.find((r) => r.id === roomId);
  if (!room) return null; // deleted meanwhile
  const floor = room.floor ?? null;
  const walls = room.walls ?? null;
  const wall = wallFinish(walls);
  const paints = paintPalette();
  const customPaint =
    wall?.kind === 'paint' &&
    !paints.some((p) => p.color.toLowerCase() === wall.color.toLowerCase());
  const others = rooms.filter((r) => r.id !== roomId);
  const floors = house ? roomFloors(house, roomId).map((f) => f.name) : [];

  return (
    <Dialog title={EDITOR.finish(room.name)} onClose={onClose} className="finish-dialog">
      {floors.length > 1 && <p className="finish-shared">{EDITOR.finishShared(floors)}</p>}
      {look !== 'home' && (
        <p className="finish-hint">
          {EDITOR.finishSeeIt}{' '}
          <button type="button" className="btn" onClick={() => setLook('home')}>
            {EDITOR.finishShowHome}
          </button>
        </p>
      )}

      <fieldset>
        <legend>{EDITOR.finishFloor}</legend>
        {floor && !floorFinish(floor) && <p className="msg err">{EDITOR.finishUnknown(floor)}</p>}
        <div className="swatches">
          <Swatch
            color={null}
            label={EDITOR.finishNone}
            pressed={floor === null}
            onClick={() => setRoomFinish(roomId, { floor: null })}
          />
        </div>
        {byGroup(floorFinishes()).map(([group, list]) => (
          <div key={group} className="finish-group">
            <h4>{group}</h4>
            <div className="swatches">
              {list.map((f) => (
                <Swatch
                  key={f.key}
                  color={f.color}
                  label={f.label}
                  pressed={floor === f.key}
                  onClick={() => setRoomFinish(roomId, { floor: f.key })}
                />
              ))}
            </div>
          </div>
        ))}
      </fieldset>

      <fieldset>
        <legend>{EDITOR.finishWalls}</legend>
        {walls && !wall && <p className="msg err">{EDITOR.finishUnknown(walls)}</p>}
        <div className="swatches">
          <Swatch
            color={null}
            label={EDITOR.finishNone}
            pressed={walls === null}
            onClick={() => setRoomFinish(roomId, { walls: null })}
          />
        </div>
        <div className="finish-group">
          <h4>{EDITOR.finishPaint}</h4>
          <div className="swatches">
            {paints.map((p) => (
              <Swatch
                key={p.color}
                color={p.color}
                label={p.label}
                pressed={
                  wall?.kind === 'paint' && wall.color.toLowerCase() === p.color.toLowerCase()
                }
                onClick={() => setRoomFinish(roomId, { walls: p.color })}
              />
            ))}
            <label className={`swatch-btn${customPaint ? ' on' : ''}`}>
              <ColorPick
                value={wall?.kind === 'paint' ? wall.color.toLowerCase() : '#ffffff'}
                label={EDITOR.finishOtherColour}
                onPick={(c) => setRoomFinish(roomId, { walls: c })}
              />
              {EDITOR.finishOtherColour}
            </label>
          </div>
        </div>
        <div className="finish-group">
          <h4>{EDITOR.finishWallpaper}</h4>
          <div className="swatches">
            {wallpaperFinishes().map((w) => (
              <Swatch
                key={w.key}
                color={w.color}
                label={w.label}
                pressed={walls === w.key}
                onClick={() => setRoomFinish(roomId, { walls: w.key })}
              />
            ))}
          </div>
        </div>
      </fieldset>

      {others.length > 0 && (
        <fieldset>
          <legend>{EDITOR.finishCopy}</legend>
          <p className="muted">{EDITOR.finishCopyHint}</p>
          <div className="finish-copy">
            {others.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  checked={copyTo.has(r.id)}
                  onChange={(e) => {
                    const next = new Set(copyTo);
                    if (e.target.checked) next.add(r.id);
                    else next.delete(r.id);
                    setCopyTo(next);
                  }}
                />
                {r.name}
              </label>
            ))}
          </div>
          <button
            type="button"
            className="btn"
            disabled={copyTo.size === 0}
            onClick={() => {
              copyFinish(roomId, [...copyTo]);
              setCopyTo(new Set());
            }}
          >
            {EDITOR.finishCopyButton(copyTo.size)}
          </button>
        </fieldset>
      )}

      <fieldset>
        <legend>{EDITOR.finishOutside}</legend>
        <div className="swatches">
          <label className="swatch-btn">
            <ColorPick
              value={(house?.exteriorWallColor ?? EXTERIOR_DEFAULT).toLowerCase()}
              label={EDITOR.finishOutside}
              onPick={(c) => setExterior(c)}
            />
            {house?.exteriorWallColor ?? EXTERIOR_DEFAULT}
          </label>
          <button
            type="button"
            className="btn"
            disabled={!house?.exteriorWallColor}
            onClick={() => setExterior(null)}
          >
            {EDITOR.finishOutsideReset}
          </button>
        </div>
      </fieldset>
      {floors.length <= 1 && <p className="muted">{EDITOR.finishSharedFloors}</p>}
    </Dialog>
  );
}
