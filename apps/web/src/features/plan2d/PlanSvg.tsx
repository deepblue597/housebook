/**
 * The drafting-sheet drawing of one floor: tiles, auto walls, openings, room labels, item
 * badges, scale bar and title block. Pure rendering of the read model; plan units are tiles × S.
 */
import { type KeyboardEvent, memo, useMemo } from 'react';
import type { Item, Opening, Placement } from '../../api/types';
import { typeLabel } from '../../catalog/catalog';
import { finishTexture, floorFinish } from '../../catalog/finishes';
import { typeIconPaths } from '../../catalog/icons';
import { PALETTE } from '../../app/theme';
import { LEVEL_TEXT, currentStatus } from '../../components/status';
import { bestTextColor, blend, parseHex } from '../../domain/color';
import { type Rect, cellKey, openingSegment, type Segment } from '../../domain/coords';
import type { Level } from '../../domain/status';
import {
  doorSwingsIntoKeyedTile,
  formatArea,
  labelPosition,
  openEdges,
  openingsOnWalls,
  roomTiles,
  walls,
} from '../../domain/plan';
import { type FloorModel, type Model, ghostRect, itemRect, occupiedTiles } from '../../store/model';
import type { Look } from '../../store/ui';
import { FOOTER, MARGIN, S } from './geometry';

interface Props {
  model: Model;
  floor: FloorModel;
  theme: 'light' | 'dark';
  selectedItemId: string | null;
  selectedRoomId: string | null;
  matches: ReadonlySet<string> | null;
  onItem: (id: string) => void;
  onRoom: (roomId: string) => void;
  /** The floor below, drawn faintly under this one while editing (D35): trace its walls. */
  underlay?: FloorModel | null;
  /** "home": rooms with a floor finish are filled with it (D41). */
  look?: Look;
}

const path = (segs: readonly Segment[]) =>
  segs.map((s) => `M${s.x1 * S} ${s.y1 * S}L${s.x2 * S} ${s.y2 * S}`).join('');

const activate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};

function StatusMark({ level }: { level: Level }) {
  // Shape differs per level, so the mark doesn't rely on colour alone.
  if (level === 'overdue')
    return (
      <g className="mark bad" transform="translate(14,-14)">
        <circle r="6" />
        <text y="3.2">!</text>
      </g>
    );
  if (level === 'due_soon')
    return <path className="mark warn" d="M14 -20.5 20.5 -14 14 -7.5 7.5 -14Z" />;
  return <rect className="mark warn" x="8.5" y="-19.5" width="11" height="11" rx="2" />;
}

export function OpeningMark({ o, floor }: { o: Opening; floor: FloorModel }) {
  const s = openingSegment(o);
  const horizontal = o.side === 'n';
  const [x1, y1, x2, y2] = [s.x1 * S, s.y1 * S, s.x2 * S, s.y2 * S];
  const inset = 0.12 * S;
  const a = horizontal ? { x: x1 + inset, y: y1 } : { x: x1, y: y1 + inset };
  const b = horizontal ? { x: x2 - inset, y: y2 } : { x: x2, y: y2 - inset };
  const gap = <line className="opening-gap" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
  if (o.kind === 'window') {
    const off = 2.5;
    const [dx, dy] = horizontal ? [0, off] : [off, 0];
    return (
      <g className="window">
        {gap}
        <line x1={a.x - dx} y1={a.y - dy} x2={b.x - dx} y2={b.y - dy} />
        <line x1={a.x + dx} y1={a.y + dy} x2={b.x + dx} y2={b.y + dy} />
      </g>
    );
  }
  // Door: leaf hinged at `a`, swinging into a room tile, with its quarter-circle sweep.
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const dir = doorSwingsIntoKeyedTile(o, floor.cells) ? 1 : -1;
  const leaf = horizontal ? { x: a.x, y: a.y + dir * len } : { x: a.x + dir * len, y: a.y };
  const sweep = horizontal === dir > 0 ? 0 : 1; // SVG sweep flag: 1 = clockwise on screen
  return (
    <g className="door">
      {gap}
      <line x1={a.x} y1={a.y} x2={leaf.x} y2={leaf.y} />
      <path d={`M${leaf.x} ${leaf.y}A${len} ${len} 0 0 ${sweep} ${b.x} ${b.y}`} />
    </g>
  );
}

const patternId = (key: string) => `finish-${key}`;

/**
 * Floor finishes as SVG patterns for the home look (D42): each finish's texture repeated at its
 * real size, in plan units (S per tile). Only the finishes used by some room are defined.
 */
function FinishPatterns({ model, tileSize }: { model: Model; tileSize: number }) {
  const used = new Map(
    [...model.rooms.values()].flatMap((r) => {
      const f = floorFinish(r.floor, model.snapshot.textures);
      const t = finishTexture(f);
      return f && t ? [[f.key, t] as const] : [];
    }),
  );
  if (used.size === 0) return null;
  const perMetre = S / tileSize;
  return (
    <defs>
      {[...used].map(([key, t]) => {
        const w = t.size[0] * perMetre;
        const h = t.size[1] * perMetre;
        return (
          <pattern key={key} id={patternId(key)} patternUnits="userSpaceOnUse" width={w} height={h}>
            <image href={t.url} width={w} height={h} preserveAspectRatio="none" />
          </pattern>
        );
      })}
    </defs>
  );
}

function PlanSvgImpl({
  model,
  floor,
  theme,
  selectedItemId,
  selectedRoomId,
  matches,
  onItem,
  onRoom,
  underlay = null,
  look = 'plan',
}: Props) {
  const { width: W, depth: H } = model.grid;
  const geometry = useMemo(() => {
    const tiles = roomTiles(floor.cells);
    const occupied = occupiedTiles(model, floor);
    const labels = [...tiles].map(([roomId, cells]) => ({
      roomId,
      cells,
      at: labelPosition(cells, floor.cells, occupied),
    }));
    let grid = '';
    for (let x = 0; x <= W; x++) grid += `M${x * S} 0V${H * S}`;
    for (let y = 0; y <= H; y++) grid += `M0 ${y * S}H${W * S}`;
    // Where each item is drawn: the centre of the tiles it occupies (data contract §2.2), as
    // in the 3D view; a multi-tile footprint also gets its full outline.
    const items = new Map(
      floor.items.flatMap((i) => {
        const r = itemRect(model, i);
        return r ? [[i.id, r] as const] : [];
      }),
    );
    const openings = model.snapshot.house?.openings ?? [];
    const openOn = (floorId: string) => openEdges(openings.filter((o) => o.floorId === floorId));
    const below = underlay ? walls(underlay.cells, openOn(underlay.floor.id)) : null;
    return {
      labels,
      walls: walls(floor.cells, openOn(floor.floor.id)),
      grid,
      items,
      underlay: below ? path([...below.exterior, ...below.interior]) : null,
    };
  }, [model, floor, W, H, underlay]);

  const palette = PALETTE[theme];
  /** Label ink on a room's fill: the plan colour as tinted, or a finish drawn at full strength. */
  const labelInk = (color: string, opaque = false) => {
    const room = parseHex(color);
    if (!room) return undefined;
    const bg = opaque ? room : blend(room, parseHex(palette.paper)!, palette.tileOpacity);
    const ink = { rgb: parseHex(palette.ink)!, value: palette.ink, halo: palette.paper };
    const paper = { rgb: parseHex(palette.paper)!, value: palette.paper, halo: palette.ink };
    return bestTextColor(bg, [ink, paper]);
  };

  const totalArea = [...floor.roomAreas.values()].reduce((a, b) => a + b, 0);
  const openings = openingsOnWalls(
    (model.snapshot.house?.openings ?? []).filter((o) => o.floorId === floor.floor.id),
    floor.cells,
  );
  const by = H * S + 30;
  const scaleTiles = Math.min(5, W);

  return (
    <>
      <rect
        className="sheet"
        x={-MARGIN}
        y={-MARGIN}
        width={W * S + 2 * MARGIN}
        height={H * S + MARGIN + FOOTER}
      />
      {look === 'home' && <FinishPatterns model={model} tileSize={model.tileSize} />}
      <path className="grid" d={geometry.grid} />
      {geometry.underlay && (
        <path className="underlay" d={geometry.underlay} data-underlay={underlay?.floor.id}>
          <title>{`${underlay?.floor.name}, the floor below`}</title>
        </path>
      )}

      {geometry.labels.map(({ roomId, cells }) => {
        const room = model.rooms.get(roomId)!;
        const area = formatArea(floor.roomAreas.get(roomId) ?? 0);
        const finish =
          look === 'home' ? floorFinish(room.floor, model.snapshot.textures) : undefined;
        return (
          <g
            key={roomId}
            className={`room${roomId === selectedRoomId ? ' sel' : ''}${finish ? ' finished' : ''}`}
            fill={
              finish
                ? finishTexture(finish)
                  ? `url(#${patternId(finish.key)})`
                  : finish.color
                : room.color
            }
            data-finish={finish?.key}
            onClick={() => onRoom(roomId)}
          >
            <title>{`${room.name}, ${area}`}</title>
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
        );
      })}

      <path className="wall-in" d={path(geometry.walls.interior)} />
      <path className="wall-ex" d={path(geometry.walls.exterior)} />
      {geometry.walls.open.length > 0 && (
        <path className="wall-open" d={path(geometry.walls.open)} />
      )}
      {openings.map((o) => (
        <OpeningMark key={`${o.x},${o.y},${o.side}`} o={o} floor={floor} />
      ))}

      {geometry.labels.map(({ roomId, cells, at }) => {
        const room = model.rooms.get(roomId)!;
        const area = formatArea(floor.roomAreas.get(roomId) ?? 0);
        const finish =
          look === 'home' ? floorFinish(room.floor, model.snapshot.textures) : undefined;
        const ink = finish ? labelInk(finish.color, true) : labelInk(room.color);
        return (
          <g
            key={roomId}
            className="rlabel"
            transform={`translate(${at.x * S},${at.y * S})`}
            role="button"
            tabIndex={0}
            aria-labelledby={`rl-${floor.floor.id}-${roomId}`}
            data-room-id={roomId}
            onClick={() => onRoom(roomId)}
            onKeyDown={activate(() => onRoom(roomId))}
            style={ink ? { fill: ink.value, stroke: ink.halo } : undefined}
          >
            <rect className="hit" x={-S} y={-12} width={2 * S} height={26} />
            {/* The name is the visible label; upper case comes from CSS so it reads normally. */}
            <text id={`rl-${floor.floor.id}-${roomId}`}>
              <tspan
                className="rname"
                x="0"
                y="-1"
                style={cells.length < 4 ? { fontSize: 9 } : undefined}
              >
                {room.name}
              </tspan>
              <tspan className="rarea" x="0" y="11">
                {` ${area}`}
              </tspan>
            </text>
          </g>
        );
      })}

      {floor.cells.size === 0 && (
        <text className="empty" x={(W * S) / 2} y={(H * S) / 2}>
          This floor has no rooms yet.
        </text>
      )}

      {floor.ghosts.map((p) => (
        <GhostBadge
          key={`ghost:${p.itemId}`}
          placement={p}
          model={model}
          selected={p.itemId === selectedItemId}
          onItem={onItem}
        />
      ))}

      {floor.items.map((item) => (
        <ItemBadge
          key={item.id}
          item={item}
          rect={geometry.items.get(item.id)!}
          model={model}
          selected={item.id === selectedItemId}
          match={matches ? matches.has(item.id) : null}
          onItem={onItem}
        />
      ))}

      {/* Name tags sit outside the buttons: they may be truncated, and the buttons' accessible
          names carry the full name (WCAG 2.5.3 label in name). */}
      <g className="inames" aria-hidden="true">
        {floor.items.map((item) => {
          const r = geometry.items.get(item.id)!;
          return (
            <text
              key={item.id}
              className={`iname${matches && !matches.has(item.id) ? ' dim' : ''}`}
              x={(r.x + r.w / 2) * S}
              y={(r.y + r.h / 2) * S + 25}
            >
              {item.name.length > 14 ? `${item.name.slice(0, 13)}…` : item.name}
            </text>
          );
        })}
      </g>

      <g className="scale" aria-hidden="true">
        {Array.from({ length: scaleTiles }, (_, i) => (
          <rect key={i} className={i % 2 ? 'b' : 'a'} x={i * S} y={by} width={S} height={6} />
        ))}
        <text x="0" y={by + 20}>
          0
        </text>
        <text x={scaleTiles * S - 14} y={by + 20}>
          {`${scaleTiles * model.tileSize} m`}
        </text>
      </g>
      <g className="north" transform={`translate(${(W * S) / 2},${by + 2})`} aria-hidden="true">
        <path d="M0 -4 L6 12 L0 8 L-6 12Z" />
        <text y="24">N</text>
      </g>
      <g className="title-block" transform={`translate(${W * S},${by + 4})`} aria-hidden="true">
        <text className="t" textAnchor="end">
          {floor.floor.name.toUpperCase()}
        </text>
        <text y="15" textAnchor="end">
          {`${formatArea(totalArea)} · ${floor.items.length} items · tile ${model.tileSize} m`}
        </text>
      </g>
    </>
  );
}

function ItemBadge({
  item,
  rect,
  model,
  selected,
  match,
  onItem,
}: {
  item: Item;
  /** Tiles the item occupies. */
  rect: Rect;
  model: Model;
  selected: boolean;
  match: boolean | null;
  onItem: (id: string) => void;
}) {
  const level = currentStatus(item, model.snapshot).level;
  const room = item.location?.roomId ? model.rooms.get(item.location.roomId)?.name : undefined;
  const label = [
    item.name,
    room,
    level ? LEVEL_TEXT[level] : null,
    item.stale ? 'note can’t be read, showing the last good version' : null,
  ]
    .filter(Boolean)
    .join(', ');
  const cls = [
    'badge',
    selected && 'sel',
    match === true && 'hit',
    match === false && 'dim',
    item.stale && 'stale',
  ];
  return (
    <g
      className={cls.filter(Boolean).join(' ')}
      transform={`translate(${(rect.x + rect.w / 2) * S},${(rect.y + rect.h / 2) * S})`}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      data-item-id={item.id}
      onClick={() => onItem(item.id)}
      onKeyDown={activate(() => onItem(item.id))}
    >
      <title>{`${item.name} (${typeLabel(item.type)})`}</title>
      {/* The hit area is every tile the item occupies, larger than the badge (DESIGN 15.12). */}
      <rect
        className={rect.w * rect.h > 1 ? 'hit fp' : 'hit'}
        x={(-rect.w * S) / 2}
        y={(-rect.h * S) / 2}
        width={rect.w * S}
        height={rect.h * S}
      />
      {selected && <circle className="ring" r="22" />}
      <rect className="bg" x="-15" y="-15" width="30" height="30" rx="7" />
      <g className="ico" transform="translate(-10,-10) scale(.8333)">
        {typeIconPaths(item.type)}
      </g>
      {level && <StatusMark level={level} />}
      {item.stale && <StaleMark />}
    </g>
  );
}

/** Bottom-left corner: the note can't be parsed (last good content still shown). */
function StaleMark() {
  return (
    <g className="mark stale" transform="translate(-14,14)">
      <path d="M0 -7 7 6 -7 6Z" />
      <text y="4.5">?</text>
    </g>
  );
}

/** A placement whose note is missing (DESIGN 15.2): a dashed ghost with a "note missing" mark. */
function GhostBadge({
  placement,
  model,
  selected,
  onItem,
}: {
  placement: Placement;
  model: Model;
  selected: boolean;
  onItem: (id: string) => void;
}) {
  const rect = ghostRect(placement);
  const floor = model.floorById.get(placement.floorId);
  const roomId = floor?.cells.get(cellKey(placement.x, placement.y));
  const room = roomId ? model.rooms.get(roomId)?.name : undefined;
  const label = ['Note missing', room, placement.itemId].filter(Boolean).join(', ');
  return (
    <g
      className={`badge ghost${selected ? ' sel' : ''}`}
      transform={`translate(${(rect.x + rect.w / 2) * S},${(rect.y + rect.h / 2) * S})`}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      data-ghost-id={placement.itemId}
      onClick={() => onItem(placement.itemId)}
      onKeyDown={activate(() => onItem(placement.itemId))}
    >
      <title>{`Note missing for ${placement.itemId}`}</title>
      <rect
        className="hit"
        x={(-rect.w * S) / 2}
        y={(-rect.h * S) / 2}
        width={rect.w * S}
        height={rect.h * S}
      />
      {selected && <circle className="ring" r="22" />}
      <rect className="bg" x="-15" y="-15" width="30" height="30" rx="7" />
      <text className="q" y="6">
        ?
      </text>
      <text className="gtag" y="27">
        note missing
      </text>
    </g>
  );
}

export const PlanSvg = memo(PlanSvgImpl);
