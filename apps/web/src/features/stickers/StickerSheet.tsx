/**
 * `/print/stickers` (D45): QR stickers that open an item (`/i/<id>`, D16). Choose the items
 * (all by default, or those in `?items=a,b`), a size, then print or save as PDF. Each sticker
 * has the code, the item's name and place, and its short link, in case a code won't scan.
 */
import { useMemo, useState } from 'react';
import type { Item } from '../../api/types';
import { STICKERS } from '../../strings/stickers';
import { useData } from '../../store/data';
import { type Model, roomOf } from '../../store/model';
import { usePaper } from '../print/usePaper';
import { qrPath, stickerUrl } from './qr';

type Size = 'small' | 'large';

interface Group {
  key: string;
  title: string;
  items: Item[];
}

/** Items in the order of the List view: floor by floor (rooms by name), unplaced last. */
function groups(model: Model): Group[] {
  const out: Group[] = model.floors.map((f) => ({
    key: f.floor.id,
    title: f.floor.name,
    items: [...f.items].sort(
      (a, b) =>
        (roomOf(model, a)?.name ?? '￿').localeCompare(roomOf(model, b)?.name ?? '￿') ||
        a.name.localeCompare(b.name),
    ),
  }));
  if (model.unplaced.length)
    out.push({ key: '_unplaced', title: STICKERS.unplaced, items: model.unplaced });
  return out.filter((g) => g.items.length > 0);
}

function initialSelection(model: Model): Set<string> {
  const asked = new URLSearchParams(location.search).get('items');
  if (asked === null) return new Set(model.items.keys());
  return new Set(asked.split(',').filter((id) => model.items.has(id)));
}

const initialSize = (): Size =>
  new URLSearchParams(location.search).get('size') === 'large' ? 'large' : 'small';

function Sticker({ item, model }: { item: Item; model: Model }) {
  const url = stickerUrl(location.origin, item.id);
  const qr = useMemo(() => qrPath(url), [url]);
  const floor = item.location ? model.floorById.get(item.location.floorId)?.floor.name : null;
  return (
    <div className="qs-sticker" data-item-id={item.id}>
      <svg
        className="qs-code"
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        role="img"
        aria-label={STICKERS.qrLabel(item.name)}
        shapeRendering="crispEdges"
        data-url={url}
      >
        <rect width={qr.size} height={qr.size} fill="#fff" />
        <path d={qr.d} fill="#000" />
      </svg>
      <div className="qs-text">
        <b>{item.name}</b>
        <span>{STICKERS.where(roomOf(model, item)?.name ?? null, floor ?? null)}</span>
        <code>{`/i/${item.id}`}</code>
      </div>
    </div>
  );
}

function Chooser({
  model,
  list,
  selected,
  setSelected,
  size,
  setSize,
}: {
  model: Model;
  list: Group[];
  selected: ReadonlySet<string>;
  setSelected: (s: Set<string>) => void;
  size: Size;
  setSize: (s: Size) => void;
}) {
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  return (
    <div className="paper-toolbar no-print">
      <div className="paper-actions">
        <a className="btn" href="/">
          {STICKERS.back}
        </a>
        <button
          type="button"
          className="btn primary"
          disabled={selected.size === 0}
          onClick={() => window.print()}
        >
          {STICKERS.print}
        </button>
        <span role="status">{STICKERS.count(selected.size)}</span>
      </div>
      <p className="paper-muted">{STICKERS.printHint}</p>
      <fieldset className="qs-size">
        <legend>{STICKERS.size}</legend>
        {(['small', 'large'] as const).map((s) => (
          <label key={s}>
            <input type="radio" name="qs-size" checked={size === s} onChange={() => setSize(s)} />{' '}
            {s === 'small' ? STICKERS.small : STICKERS.large}
          </label>
        ))}
      </fieldset>
      <fieldset className="qs-choose">
        <legend>{STICKERS.choose}</legend>
        <div className="paper-actions">
          <button
            type="button"
            className="btn"
            onClick={() => setSelected(new Set(model.items.keys()))}
          >
            {STICKERS.all}
          </button>
          <button type="button" className="btn" onClick={() => setSelected(new Set())}>
            {STICKERS.none}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              setSelected(
                new Set([...model.items.values()].filter((i) => i.critical).map((i) => i.id)),
              )
            }
          >
            {STICKERS.emergency}
          </button>
        </div>
        {list.map((g) => (
          <fieldset key={g.key} className="qs-group">
            <legend>{g.title}</legend>
            {g.items.map((i) => (
              <label key={i.id}>
                <input
                  type="checkbox"
                  checked={selected.has(i.id)}
                  onChange={(e) => toggle(i.id, e.target.checked)}
                />{' '}
                {i.name}
                {roomOf(model, i) && (
                  <span className="paper-muted"> · {roomOf(model, i)!.name}</span>
                )}
              </label>
            ))}
          </fieldset>
        ))}
      </fieldset>
    </div>
  );
}

function Stickers({ model }: { model: Model }) {
  const list = useMemo(() => groups(model), [model]);
  const [selected, setSelected] = useState<Set<string>>(() => initialSelection(model));
  const [size, setSize] = useState<Size>(initialSize);
  const chosen = list.flatMap((g) => g.items).filter((i) => selected.has(i.id));
  return (
    <>
      <Chooser
        model={model}
        list={list}
        selected={selected}
        setSelected={setSelected}
        size={size}
        setSize={setSize}
      />
      <h1 className="no-print qs-title">{STICKERS.title}</h1>
      {model.items.size === 0 ? (
        <p>{STICKERS.noItems}</p>
      ) : chosen.length === 0 ? (
        <p className="no-print">{STICKERS.nothing}</p>
      ) : (
        <div className={`qs-sheet ${size}`}>
          {chosen.map((i) => (
            <Sticker key={i.id} item={i} model={model} />
          ))}
        </div>
      )}
    </>
  );
}

export default function StickerSheetPage() {
  const state = useData((s) => s.state);
  const model = useData((s) => s.model);
  const error = useData((s) => s.error);
  const load = useData((s) => s.load);
  usePaper(STICKERS.title);

  if (!model) {
    return (
      <main className="paper-page">
        {state === 'error' ? (
          <div role="alert">
            <p>{STICKERS.loadFailed}</p>
            <p className="paper-muted">{error}</p>
            <button type="button" className="btn primary" onClick={() => void load()}>
              {STICKERS.retry}
            </button>
          </div>
        ) : (
          <p role="status">{STICKERS.loading}</p>
        )}
      </main>
    );
  }
  return (
    <main className="paper-page">
      <Stickers model={model} />
    </main>
  );
}
