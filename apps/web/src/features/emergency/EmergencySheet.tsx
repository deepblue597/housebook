/**
 * `/print/emergency` (DESIGN 15.11, D44): a page laid out for paper. Each floor with emergency
 * items gets its plan with numbered markers, then the items: where they are, make and model,
 * support, and the note's quick help. The browser prints it or saves it as a PDF; the sheet
 * carries the date and a version (a fingerprint of its content), so an old copy can be told
 * from a new one. Always drawn in the light theme: it is meant for paper.
 */
import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { cellKey } from '../../domain/coords';
import { labelPosition, openEdges, openingsOnWalls, roomTiles, walls } from '../../domain/plan';
import { EMERGENCY } from '../../strings/emergency';
import { useData } from '../../store/data';
import type { Model } from '../../store/model';
import { loadMarkdown } from '../details/markdownLoader';
import { S } from '../plan2d/geometry';
import { usePaper } from '../print/usePaper';
import { OpeningMark } from '../plan2d/PlanSvg';
import { type Printed, readPrinted, savePrinted } from './printed';
import {
  type Sheet,
  type SheetFloor,
  type SheetItem,
  emergencySheet,
  sheetFingerprint,
} from './sheet';

const MarkdownBody = lazy(loadMarkdown);
const noLinks = () => null;
const noNavigate = () => undefined;

/** `tel:+30…` → `+30…`; other links as written. */
const linkText = (url: string) => url.replace(/^(tel|mailto):/i, '');

const path = (segs: readonly { x1: number; y1: number; x2: number; y2: number }[]) =>
  segs.map((s) => `M${s.x1 * S} ${s.y1 * S}L${s.x2 * S} ${s.y2 * S}`).join('');

function PrintPlan({ model, sheetFloor }: { model: Model; sheetFloor: SheetFloor }) {
  const { floor, bounds, items } = sheetFloor;
  const pad = 0.6;
  const view = [
    (bounds.x - pad) * S,
    (bounds.y - pad) * S,
    (bounds.w + 2 * pad) * S,
    (bounds.h + 2 * pad) * S,
  ].join(' ');
  const tiles = roomTiles(floor.cells);
  // Room names keep clear of the markers.
  const marked = new Set(
    items.flatMap((s) => {
      const r = s.rect;
      if (!r) return [];
      const keys: string[] = [];
      for (let x = r.x; x < r.x + r.w; x++)
        for (let y = r.y; y < r.y + r.h; y++) keys.push(cellKey(x, y));
      return keys;
    }),
  );
  const onFloor = (model.snapshot.house?.openings ?? []).filter(
    (o) => o.floorId === floor.floor.id,
  );
  const w = walls(floor.cells, openEdges(onFloor));
  const openings = openingsOnWalls(onFloor, floor.cells);
  return (
    <svg
      className="es-plan"
      viewBox={view}
      role="img"
      aria-label={EMERGENCY.plan(floor.floor.name)}
    >
      {[...tiles].map(([roomId, cells]) => (
        <g key={roomId} fill={model.rooms.get(roomId)?.color}>
          {cells.map((c) => (
            <rect
              key={cellKey(c.x, c.y)}
              className="tile"
              x={c.x * S}
              y={c.y * S}
              width={S}
              height={S}
            />
          ))}
        </g>
      ))}
      <path className="wall-in" d={path(w.interior)} />
      <path className="wall-ex" d={path(w.exterior)} />
      {w.open.length > 0 && <path className="wall-open" d={path(w.open)} />}
      {openings.map((o) => (
        <OpeningMark key={`${o.x},${o.y},${o.side}`} o={o} floor={floor} />
      ))}
      {[...tiles].map(([roomId, cells]) => {
        const at = labelPosition(cells, floor.cells, marked);
        return (
          <text key={roomId} className="es-room" x={at.x * S} y={at.y * S + 4}>
            {model.rooms.get(roomId)?.name}
          </text>
        );
      })}
      {items.map((s) => {
        const r = s.rect;
        if (!r) return null;
        const cx = (r.x + r.w / 2) * S;
        const cy = (r.y + r.h / 2) * S;
        return (
          <g key={s.item.id} className="es-marker" data-item-id={s.item.id}>
            {r.w * r.h > 1 && (
              <rect
                className="es-footprint"
                x={r.x * S}
                y={r.y * S}
                width={r.w * S}
                height={r.h * S}
              />
            )}
            <circle cx={cx} cy={cy} r={13} />
            <text x={cx} y={cy + 5}>
              {s.n}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function ItemEntry({ s }: { s: SheetItem }) {
  const { item } = s;
  const make = [item.fields.brand, item.fields.model].filter(Boolean).join(' ');
  return (
    <li className="es-item" data-item-id={item.id}>
      <span className="es-n" aria-hidden="true">
        {s.n}
      </span>
      <div className="es-body">
        <h3>
          {item.name}
          {item.type && s.typeLabel !== item.name && (
            <span className="es-type"> · {s.typeLabel}</span>
          )}
        </h3>
        <p className="es-where">{EMERGENCY.where(s.room, s.floor)}</p>
        {make && (
          <p>
            {EMERGENCY.brandModel}: {make}
          </p>
        )}
        {item.fields.support && (
          <p>
            {EMERGENCY.support}: {linkText(item.fields.support)}
          </p>
        )}
        {s.help ? (
          <div className="es-help">
            <Suspense fallback={<pre className="es-help-plain">{s.help}</pre>}>
              <MarkdownBody body={s.help} resolve={noLinks} onNavigate={noNavigate} />
            </Suspense>
          </div>
        ) : (
          <p className="paper-muted">{EMERGENCY.noHelp}</p>
        )}
      </div>
    </li>
  );
}

function Items({ list }: { list: readonly SheetItem[] }) {
  return (
    <ol className="es-items" start={list[0]?.n}>
      {list.map((s) => (
        <ItemEntry key={s.item.id} s={s} />
      ))}
    </ol>
  );
}

function Toolbar({
  fingerprint,
  today,
  printed,
  onPrinted,
}: {
  fingerprint: string;
  today: string;
  printed: Printed | null;
  onPrinted: (p: Printed) => void;
}) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    const after = () => setAsking(true);
    window.addEventListener('afterprint', after);
    return () => window.removeEventListener('afterprint', after);
  }, []);
  return (
    <div className="paper-toolbar no-print">
      <div className="paper-actions">
        <a className="btn" href="/">
          {EMERGENCY.back}
        </a>
        <button type="button" className="btn primary" onClick={() => window.print()}>
          {EMERGENCY.print}
        </button>
      </div>
      <p className="paper-muted">{EMERGENCY.printHint}</p>
      {printed && !asking && (
        <p role="status" data-printed={printed.fingerprint === fingerprint ? 'current' : 'old'}>
          {EMERGENCY.lastPrinted(printed.date)}{' '}
          {printed.fingerprint === fingerprint ? EMERGENCY.upToDate : EMERGENCY.outOfDate}
        </p>
      )}
      {asking && (
        <div className="es-ask" role="group" aria-label={EMERGENCY.askPrinted}>
          <p>
            <b>{EMERGENCY.askPrinted}</b> {EMERGENCY.askPrintedHint}
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onPrinted({ fingerprint, date: today });
              setAsking(false);
            }}
          >
            {EMERGENCY.yesPrinted}
          </button>
          <button type="button" className="btn" onClick={() => setAsking(false)}>
            {EMERGENCY.notPrinted}
          </button>
        </div>
      )}
    </div>
  );
}

function SheetBody({
  model,
  sheet,
  fingerprint,
}: {
  model: Model;
  sheet: Sheet;
  fingerprint: string;
}) {
  return (
    <article className="es-sheet">
      <header className="es-head">
        <h1>{EMERGENCY.title}</h1>
        <p>{EMERGENCY.intro}</p>
        <p className="paper-muted" data-version={fingerprint}>
          {EMERGENCY.printed(model.snapshot.today, fingerprint)}
        </p>
      </header>
      {sheet.count === 0 && (
        <section className="es-empty">
          <p>
            <b>{EMERGENCY.none}</b>
          </p>
          <p>{EMERGENCY.noneHelp}</p>
        </section>
      )}
      {sheet.floors.map((f) => (
        <section
          key={f.floor.floor.id}
          className="es-floor"
          aria-labelledby={`es-${f.floor.floor.id}`}
        >
          <h2 id={`es-${f.floor.floor.id}`}>{f.floor.floor.name}</h2>
          <PrintPlan model={model} sheetFloor={f} />
          <Items list={f.items} />
        </section>
      ))}
      {sheet.unplaced.length > 0 && (
        <section className="es-floor" aria-labelledby="es-unplaced">
          <h2 id="es-unplaced">{EMERGENCY.unplaced}</h2>
          <Items list={sheet.unplaced} />
        </section>
      )}
    </article>
  );
}

export default function EmergencySheetPage() {
  const state = useData((s) => s.state);
  const model = useData((s) => s.model);
  const error = useData((s) => s.error);
  const load = useData((s) => s.load);
  const [printed, setPrinted] = useState<Printed | null>(readPrinted);

  usePaper(EMERGENCY.title);

  const sheet = useMemo(() => (model ? emergencySheet(model) : null), [model]);
  const fingerprint = useMemo(
    () => (model && sheet ? sheetFingerprint(model, sheet) : ''),
    [model, sheet],
  );

  if (!model || !sheet) {
    return (
      <main className="paper-page">
        {state === 'error' ? (
          <div role="alert">
            <p>{EMERGENCY.loadFailed}</p>
            <p className="paper-muted">{error}</p>
            <button type="button" className="btn primary" onClick={() => void load()}>
              {EMERGENCY.retry}
            </button>
          </div>
        ) : (
          <p role="status">{EMERGENCY.loading}</p>
        )}
      </main>
    );
  }
  return (
    <main className="paper-page">
      <Toolbar
        fingerprint={fingerprint}
        today={model.snapshot.today}
        printed={printed}
        onPrinted={(p) => {
          savePrinted(p);
          setPrinted(p);
        }}
      />
      <SheetBody model={model} sheet={sheet} fingerprint={fingerprint} />
    </main>
  );
}
