/**
 * The scene graph for one floor: room floors (one merged mesh per room), walls (one merged mesh
 * for the floor), window panes and items. A pure rendering of the layout and the UI state; no
 * camera. Labels and badges are DOM overlays (SceneOverlays).
 */
import type { ThreeEvent } from '@react-three/fiber';
import { memo, useEffect, useMemo } from 'react';
import { BoxGeometry, BufferAttribute, BufferGeometry, DoubleSide, EdgesGeometry } from 'three';
import type { Snapshot } from '../../api/types';
import { blend, parseHex, toHex } from '../../domain/color';
import { type Heading, type MeshData, boxesMesh, roomAtPoint, tilesMesh } from '../../domain/scene';
import type { CellMap } from '../../domain/plan';
import { type Highlight, ItemModel } from './ItemModel';
import { type SceneGhost, type SceneItem, type SceneLayout, wallMeshes } from './layout';
import type { ScenePalette } from './palette';

/** Walls facing the camera, with walls up: enough to see the room shape, not to hide it. */
export const FADED_WALL_OPACITY = 0.2;

/** Pointer travel (CSS px) above which a press is a drag, not a click (as in the 2D plan). */
export const DRAG_PX = 6;

export interface SceneContentProps {
  layout: SceneLayout;
  cells: CellMap;
  /** Where the camera looks: walls facing it fade when they are up. */
  heading: Heading;
  snapshot: Snapshot;
  palette: ScenePalette;
  selectedItemId: string | null;
  selectedRoomId: string | null;
  /** Search matches, or null when no search is active. */
  matches: ReadonlySet<string> | null;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  onItem: (id: string) => void;
  onRoom: (roomId: string) => void;
}

const mix = (a: string, b: string, share: number) => {
  const [x, y] = [parseHex(a), parseHex(b)];
  return x && y ? toHex(blend(y, x, share)) : a;
};

function toGeometry(m: MeshData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(m.positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(m.normals), 3));
  g.setIndex(m.indices);
  g.computeBoundingSphere();
  return g;
}

/** A BufferGeometry for `data`, disposed when it changes or unmounts. */
function useGeometry(data: MeshData): BufferGeometry {
  const g = useMemo(() => toGeometry(data), [data]);
  useEffect(() => () => g.dispose(), [g]);
  return g;
}

function gridLines(width: number, depth: number, ts: number): MeshData {
  const positions: number[] = [];
  for (let x = 0; x <= width; x++) positions.push(x * ts, 0, 0, x * ts, 0, depth * ts);
  for (let y = 0; y <= depth; y++) positions.push(0, 0, y * ts, width * ts, 0, y * ts);
  return { positions, normals: [], indices: [] };
}

function Grid({
  width,
  depth,
  ts,
  color,
}: {
  width: number;
  depth: number;
  ts: number;
  color: string;
}) {
  const g = useMemo(() => {
    const geo = new BufferGeometry();
    geo.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(gridLines(width, depth, ts).positions), 3),
    );
    return geo;
  }, [width, depth, ts]);
  useEffect(() => () => g.dispose(), [g]);
  return (
    // Below the floor so it never shows through the seams between floor quads.
    <lineSegments name="grid" geometry={g} position={[0, -0.03, 0]} raycast={() => null}>
      <lineBasicMaterial color={color} />
    </lineSegments>
  );
}

function RoomFloor({
  tiles,
  color,
  selected,
  accent,
  roomId,
  ts,
  onClick,
}: {
  tiles: SceneLayout['rooms'][number]['tiles'];
  color: string;
  selected: boolean;
  accent: string;
  roomId: string;
  ts: number;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}) {
  const accentMix = useMemo(() => mix(color, accent, 0.25), [color, accent]);
  const data = useMemo(() => tilesMesh(tiles, ts), [tiles, ts]);
  const g = useGeometry(data);
  return (
    <mesh name={`floor:${roomId}`} geometry={g} onClick={onClick}>
      {/* Unlit, so the floor shows exactly the room's (softened) colour, as in 2D. */}
      <meshBasicMaterial color={selected ? accentMix : color} side={DoubleSide} />
    </mesh>
  );
}

function ItemNode({
  it,
  highlight,
  dim,
  accent,
  onHover,
  onItem,
}: {
  it: SceneItem;
  highlight: Highlight;
  dim: boolean;
  accent: string;
  onHover: (id: string | null) => void;
  onItem: (id: string) => void;
}) {
  const t = it.transform;
  // The hit area covers the whole footprint (DESIGN 15.12: larger than the model), at the
  // model's height range, so a small router or valve is still easy to click.
  const hit = {
    x: Math.max(t.size.x, t.footprint.x * 0.9),
    y: Math.max(0.3, t.size.y),
    z: Math.max(t.size.z, Math.min(0.3, t.footprint.z * 0.9)),
  };
  const ring = Math.max(t.footprint.x, t.footprint.z) / 2;
  return (
    <group
      name={`item:${it.id}`}
      userData={{ itemId: it.id }}
      position={[t.position.x, t.position.y, t.position.z]}
      rotation={[0, t.rotationY, 0]}
      onClick={(e) => {
        if (e.delta > DRAG_PX) return;
        e.stopPropagation();
        onItem(it.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover(it.id);
      }}
      onPointerOut={() => onHover(null)}
    >
      <ItemModel
        type={it.item.type ?? null}
        mount={it.mount}
        size={t.size}
        tint={it.model.tint}
        highlight={highlight}
        dim={dim}
        accent={accent}
      />
      <mesh name="hit" visible={false}>
        <boxGeometry args={[hit.x, hit.y, it.mount === 'floor' ? t.footprint.z * 0.9 : hit.z]} />
      </mesh>
      {highlight === 'selected' && (
        <mesh
          name="ring"
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, -t.position.y + 0.01, 0]}
          raycast={() => null}
        >
          <ringGeometry args={[ring * 0.92, ring * 1.08, 48]} />
          <meshBasicMaterial color={accent} side={DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

/** A placement without a note: a translucent box, clickable like an item. */
function GhostNode({
  g,
  selected,
  accent,
  color,
  onHover,
  onItem,
}: {
  g: SceneGhost;
  selected: boolean;
  accent: string;
  color: string;
  onHover: (id: string | null) => void;
  onItem: (id: string) => void;
}) {
  const t = g.transform;
  const box = useMemo(() => new BoxGeometry(t.size.x, t.size.y, t.size.z), [t.size]);
  const edges = useMemo(() => new EdgesGeometry(box), [box]);
  useEffect(
    () => () => {
      box.dispose();
      edges.dispose();
    },
    [box, edges],
  );
  return (
    <group
      name={`ghost:${g.id}`}
      userData={{ ghostId: g.id }}
      position={[t.position.x, t.position.y, t.position.z]}
      rotation={[0, t.rotationY, 0]}
      onClick={(e) => {
        if (e.delta > DRAG_PX) return;
        e.stopPropagation();
        onItem(g.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        onHover(g.id);
      }}
      onPointerOut={() => onHover(null)}
    >
      <mesh geometry={box}>
        <meshBasicMaterial
          color={selected ? accent : color}
          transparent
          opacity={0.25}
          depthWrite={false}
        />
      </mesh>
      <lineSegments geometry={edges} raycast={() => null}>
        <lineBasicMaterial color={selected ? accent : color} />
      </lineSegments>
    </group>
  );
}

function SceneContentImpl({
  layout,
  cells,
  heading,
  snapshot,
  palette,
  selectedItemId,
  selectedRoomId,
  matches,
  hoverId,
  onHover,
  onItem,
  onRoom,
}: SceneContentProps) {
  const ts = layout.tileSize;
  const wm = useMemo(() => wallMeshes(layout, cells, heading), [layout, cells, heading]);
  const wallData = useMemo(() => boxesMesh(wm.solid), [wm]);
  const fadedData = useMemo(() => boxesMesh(wm.faded), [wm]);
  const glassData = useMemo(() => boxesMesh(wm.glass), [wm]);
  const wallGeo = useGeometry(wallData);
  const fadedGeo = useGeometry(fadedData);
  const glassGeo = useGeometry(glassData);
  const grid = snapshot.house?.grid;

  // Picking (DESIGN §7.4): items stop the event first; a click on the floor maps the hit point
  // to a grid cell, and the cell to its room.
  const onFloor = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > DRAG_PX) return;
    e.stopPropagation();
    const roomId = roomAtPoint(cells, e.point.x, e.point.z, ts);
    if (roomId) onRoom(roomId);
  };

  return (
    <group name={`floor-plan:${layout.floorId}`}>
      {/* three's lights are physical: intensity π gives a Lambert surface its own colour. */}
      <ambientLight intensity={0.62 * Math.PI} />
      <directionalLight position={[-4, 10, 6]} intensity={0.42 * Math.PI} />
      {grid && <Grid width={grid.width} depth={grid.depth} ts={ts} color={palette.grid} />}

      {layout.rooms.map((r) => (
        <RoomFloor
          key={r.roomId}
          roomId={r.roomId}
          tiles={r.tiles}
          ts={ts}
          color={palette.floor(r.color)}
          selected={r.roomId === selectedRoomId}
          accent={palette.accent}
          onClick={onFloor}
        />
      ))}

      {wm.solid.length > 0 && (
        <mesh name="walls" geometry={wallGeo} raycast={() => null}>
          <meshLambertMaterial color={palette.wall} />
        </mesh>
      )}
      {wm.faded.length > 0 && (
        <mesh name="walls-faded" geometry={fadedGeo} raycast={() => null}>
          <meshLambertMaterial
            color={palette.wall}
            transparent
            opacity={FADED_WALL_OPACITY}
            depthWrite={false}
          />
        </mesh>
      )}
      {wm.glass.length > 0 && (
        <mesh name="glass" geometry={glassGeo} raycast={() => null}>
          <meshLambertMaterial
            color={palette.glass}
            transparent
            opacity={0.45}
            depthWrite={false}
          />
        </mesh>
      )}

      {layout.items.map((it) => {
        const highlight: Highlight =
          it.id === selectedItemId ? 'selected' : it.id === hoverId ? 'hover' : 'none';
        return (
          <ItemNode
            key={it.id}
            it={it}
            highlight={highlight}
            dim={matches !== null && !matches.has(it.id)}
            accent={palette.accent}
            onHover={onHover}
            onItem={onItem}
          />
        );
      })}
      {layout.ghosts.map((g) => (
        <GhostNode
          key={g.id}
          g={g}
          selected={g.id === selectedItemId}
          accent={palette.accent}
          color={palette.wall}
          onHover={onHover}
          onItem={onItem}
        />
      ))}
    </group>
  );
}

export const SceneContent = memo(SceneContentImpl);
