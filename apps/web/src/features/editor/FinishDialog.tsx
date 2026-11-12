/**
 * A room's floor and wall finish (D41), from the room list. Every choice is an editor command
 * (undo, autosave); "copy to other rooms" is one step for all of them. Your own textures (D43)
 * are uploaded and deleted here too: those are server writes, not undoable layout edits.
 */
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, MAX_UPLOAD_BYTES } from '../../api/client';
import type { OwnTexture } from '../../api/types';
import {
  EXTERIOR_DEFAULT,
  type Finish,
  finishTexture,
  floorFinish,
  floorFinishes,
  ownFinishes,
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
  texture,
  label,
  pressed,
  onClick,
  note,
}: {
  color: string | null;
  /** A finish's texture (D42): the swatch shows a piece of it. */
  texture?: string;
  label: string;
  pressed: boolean;
  onClick: () => void;
  /** Shown after the label, e.g. "image missing". */
  note?: string;
}) {
  return (
    <button
      type="button"
      className="swatch-btn"
      aria-pressed={pressed}
      onClick={onClick}
      title={note ? `${label} (${note})` : label}
    >
      <span
        className={`swatch${color ? '' : ' none'}`}
        style={
          texture
            ? { background: `${color ?? ''} url("${texture}") center / 200% auto` }
            : color
              ? { background: color }
              : undefined
        }
        aria-hidden="true"
      />
      {label}
      {note && <span className="muted"> ({note})</span>}
    </button>
  );
}

type Kind = OwnTexture['kind'];

function uploadError(e: unknown): string {
  if (!(e instanceof ApiError)) return EDITOR.ownUnreachable;
  if (e.status === 413) return EDITOR.ownTooLarge;
  if (e.status === 415) return EDITOR.ownWrongType;
  return e.detail ?? e.message;
}

const stem = (name: string) =>
  name
    .replace(/\.[^.]*$/, '')
    .trim()
    .slice(0, 60);

/** Upload form for your own floor or wallpaper (D43): the image and how much of it repeats. */
function AddTexture({
  kind,
  onAdded,
  onCancel,
}: {
  kind: Kind;
  onAdded: (key: string) => void;
  onCancel: () => void;
}) {
  const addTexture = useData((s) => s.addTexture);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [across, setAcross] = useState('50');
  const [along, setAlong] = useState('50');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const w = Number(across);
    const h = Number(along);
    const label = name.trim();
    const problem = !file
      ? EDITOR.ownNeedFile
      : file.size > MAX_UPLOAD_BYTES
        ? EDITOR.ownTooLarge
        : !label
          ? EDITOR.ownNeedName
          : !(w >= 1 && w <= 2000 && h >= 1 && h <= 2000)
            ? EDITOR.ownBadSize
            : null;
    if (problem || !file) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const t = await addTexture(file, { kind, label, width: w / 100, height: h / 100 });
      onAdded(t.key);
    } catch (err) {
      setError(uploadError(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="own-form"
      onSubmit={(e) => void submit(e)}
      aria-label={EDITOR.ownAddTitle(kind)}
    >
      <label>
        {EDITOR.ownFile}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            if (f && !name.trim()) setName(stem(f.name));
          }}
        />
      </label>
      <label>
        {EDITOR.ownName}
        <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </label>
      <fieldset className="own-size">
        <legend>{EDITOR.ownRepeat}</legend>
        <label>
          <input
            type="number"
            min={1}
            max={2000}
            step="any"
            value={across}
            onChange={(e) => setAcross(e.target.value)}
          />{' '}
          {EDITOR.ownAcross}
        </label>
        <label>
          <input
            type="number"
            min={1}
            max={2000}
            step="any"
            value={along}
            onChange={(e) => setAlong(e.target.value)}
          />{' '}
          {EDITOR.ownAlong(kind)}
        </label>
      </fieldset>
      <p className="muted">{EDITOR.ownRepeatHint}</p>
      {error && (
        <p className="msg err" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? EDITOR.ownSaving : EDITOR.ownSave}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          {EDITOR.ownCancel}
        </button>
      </div>
    </form>
  );
}

/**
 * The "Your own" group of a fieldset: uploaded textures of one kind as swatches, each with a
 * delete button, and the upload form.
 */
function OwnTextures({
  kind,
  selected,
  onPick,
}: {
  kind: Kind;
  selected: string | null;
  onPick: (key: string) => void;
}) {
  const own = useData((s) => s.model?.snapshot.textures);
  const rooms = useData((s) => s.model?.snapshot.house?.rooms) ?? [];
  const removeTexture = useData((s) => s.removeTexture);
  const [adding, setAdding] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const list = ownFinishes(own, kind);

  const remove = async (key: string, label: string) => {
    setAsking(null);
    // The layout shown may have unsaved edits the server doesn't know about yet.
    const users = rooms.filter((r) => r.floor === key || r.walls === key).map((r) => r.name);
    if (users.length > 0) {
      setMsg(EDITOR.ownInUse(label, users));
      return;
    }
    setMsg(null);
    try {
      await removeTexture(key);
    } catch (e) {
      setMsg(uploadError(e));
    }
  };

  return (
    <div className="finish-group own" data-own={kind}>
      <h4>{EDITOR.ownTextures}</h4>
      {list.length > 0 && (
        <div className="swatches">
          {list.map((f) => (
            <span key={f.key} className="own-swatch">
              <Swatch
                color={f.color}
                texture={finishTexture(f)?.url}
                label={f.label}
                note={f.own?.url ? undefined : EDITOR.ownMissing}
                pressed={selected === f.key}
                onClick={() => onPick(f.key)}
              />
              <button
                type="button"
                className="btn icon"
                aria-label={EDITOR.ownDelete(f.label)}
                title={EDITOR.ownDelete(f.label)}
                onClick={() => setAsking(f.key)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {asking && (
        <p className="own-ask" role="alert">
          {EDITOR.ownDeleteAsk(list.find((f) => f.key === asking)?.label ?? asking)}{' '}
          <button
            type="button"
            className="btn"
            onClick={() => void remove(asking, list.find((f) => f.key === asking)?.label ?? asking)}
          >
            {EDITOR.ownDeleteYes}
          </button>{' '}
          <button type="button" className="btn" onClick={() => setAsking(null)}>
            {EDITOR.ownDeleteNo}
          </button>
        </p>
      )}
      {msg && (
        <p className="msg err" role="alert">
          {msg}
        </p>
      )}
      {adding ? (
        <AddTexture
          kind={kind}
          onAdded={(key) => {
            setAdding(false);
            onPick(key);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          {EDITOR.ownAdd(kind)}
        </button>
      )}
    </div>
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
  const own = useData((s) => s.model?.snapshot.textures);
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
  const wall = wallFinish(walls, own);
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
        {floor && !floorFinish(floor, own) && (
          <p className="msg err">{EDITOR.finishUnknown(floor)}</p>
        )}
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
                  texture={finishTexture(f)?.url}
                  label={f.label}
                  pressed={floor === f.key}
                  onClick={() => setRoomFinish(roomId, { floor: f.key })}
                />
              ))}
            </div>
          </div>
        ))}
        <OwnTextures
          kind="floor"
          selected={floor}
          onPick={(key) => setRoomFinish(roomId, { floor: key })}
        />
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
                texture={finishTexture(w)?.url}
                label={w.label}
                pressed={walls === w.key}
                onClick={() => setRoomFinish(roomId, { walls: w.key })}
              />
            ))}
          </div>
        </div>
        <OwnTextures
          kind="wallpaper"
          selected={walls}
          onPick={(key) => setRoomFinish(roomId, { walls: key })}
        />
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
