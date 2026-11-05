/**
 * The drafting-sheet drawing of one floor: tiles, auto walls, openings, room labels, item
 * badges, scale bar and title block. Pure rendering of the read model; plan units are tiles × S.
 */
import { type KeyboardEvent, memo, useMemo } from 'react';
import type { Item, Opening } from '../../api/types';
import { typeLabel } from '../../catalog/catalog';
import { typeIconPaths } from '../../catalog/icons';
import { PALETTE } from '../../app/theme';
import { LEVEL_TEXT, currentStatus } from '../../components/status';
import { bestTextColor, blend, parseHex } from '../../domain/color';
import { cellKey, openingSegment, type Segment } from '../../domain/coords';
import type { Level } from '../../domain/status';
import {
  doorSwingsIntoKeyedTile,
  formatArea,
  labelPosition,
  roomTiles,
  walls,
} from '../../domain/plan';
import type { FloorModel, Model } from '../../store/model';
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

function OpeningMark({ o, floor }: { o: Opening; floor: FloorModel }) {
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

function PlanSvgImpl({
  model,
  floor,
  theme,
  selectedItemId,
  selectedRoomId,
  matches,
  onItem,
  onRoom,
}: Props) {
  const { width: W, depth: H } = model.grid;
  const geometry = useMemo(() => {
    const tiles = roomTiles(floor.cells);
    const occupied = new Set(
      floor.items.flatMap((i) => (i.location ? [cellKey(i.location.x, i.location.y)] : [])),
    );
    const labels = [...tiles].map(([roomId, cells]) => ({
      roomId,
      cells,
      at: labelPosition(cells, floor.cells, occupied),
    }));
    let grid = '';
    for (let x = 0; x <= W; x++) grid += `M${x * S} 0V${H * S}`;
    for (let y = 0; y <= H; y++) grid += `M0 ${y * S}H${W * S}`;
    return { labels, walls: walls(floor.cells), grid };
  }, [floor, W, H]);

  const palette = PALETTE[theme];
  const labelInk = (color: string) => {
    const room = parseHex(color);
    if (!room) return undefined;
    const bg = blend(room, parseHex(palette.paper)!, palette.tileOpacity);
    const ink = { rgb: parseHex(palette.ink)!, value: palette.ink, halo: palette.paper };
    const paper = { rgb: parseHex(palette.paper)!, value: palette.paper, halo: palette.ink };
    return bestTextColor(bg, [ink, paper]);
  };

  const totalArea = [...floor.roomAreas.values()].reduce((a, b) => a + b, 0);
  const openings = (model.snapshot.house?.openings ?? []).filter(
    (o) => o.floorId === floor.floor.id,
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
      <path className="grid" d={geometry.grid} />

      {geometry.labels.map(({ roomId, cells }) => {
        const room = model.rooms.get(roomId)!;
        const area = formatArea(floor.roomAreas.get(roomId) ?? 0);
        return (
          <g
            key={roomId}
            className={`room${roomId === selectedRoomId ? ' sel' : ''}`}
            fill={room.color}
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
      {openings.map((o) => (
        <OpeningMark key={`${o.x},${o.y},${o.side}`} o={o} floor={floor} />
      ))}

      {geometry.labels.map(({ roomId, cells, at }) => {
        const room = model.rooms.get(roomId)!;
        const area = formatArea(floor.roomAreas.get(roomId) ?? 0);
        const ink = labelInk(room.color);
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

      {floor.items.map((item) => (
        <ItemBadge
          key={item.id}
          item={item}
          model={model}
          selected={item.id === selectedItemId}
          match={matches ? matches.has(item.id) : null}
          onItem={onItem}
        />
      ))}

      {/* Name tags sit outside the buttons: they may be truncated, and the buttons' accessible
          names carry the full name (WCAG 2.5.3 label in name). */}
      <g className="inames" aria-hidden="true">
        {floor.items.map((item) => (
          <text
            key={item.id}
            className={`iname${matches && !matches.has(item.id) ? ' dim' : ''}`}
            x={item.location!.x * S + S / 2}
            y={item.location!.y * S + S / 2 + 25}
          >
            {item.name.length > 14 ? `${item.name.slice(0, 13)}…` : item.name}
          </text>
        ))}
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
  model,
  selected,
  match,
  onItem,
}: {
  item: Item;
  model: Model;
  selected: boolean;
  match: boolean | null;
  onItem: (id: string) => void;
}) {
  const loc = item.location!;
  const level = currentStatus(item, model.snapshot).level;
  const room = item.location?.roomId ? model.rooms.get(item.location.roomId)?.name : undefined;
  const label = [item.name, room, level ? LEVEL_TEXT[level] : null].filter(Boolean).join(', ');
  const cls = ['badge', selected && 'sel', match === true && 'hit', match === false && 'dim'];
  return (
    <g
      className={cls.filter(Boolean).join(' ')}
      transform={`translate(${loc.x * S + S / 2},${loc.y * S + S / 2})`}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      data-item-id={item.id}
      onClick={() => onItem(item.id)}
      onKeyDown={activate(() => onItem(item.id))}
    >
      <title>{`${item.name} (${typeLabel(item.type)})`}</title>
      {/* The hit area is the whole tile, larger than the badge (DESIGN 15.12). */}
      <rect className="hit" x={-S / 2} y={-S / 2} width={S} height={S} />
      {selected && <circle className="ring" r="22" />}
      <rect className="bg" x="-15" y="-15" width="30" height="30" rx="7" />
      <g className="ico" transform="translate(-10,-10) scale(.8333)">
        {typeIconPaths(item.type)}
      </g>
      {level && <StatusMark level={level} />}
    </g>
  );
}

export const PlanSvg = memo(PlanSvgImpl);
