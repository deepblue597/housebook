/**
 * What the 3D view draws for one floor, derived from the same read model as the 2D plan
 * ("one model, many views"): room floors, walls from the shared wall-edge logic, item
 * transforms and label positions. Pure; the components only turn it into meshes.
 */
import type { Item } from '../../api/types';
import { modelSpec, placementSpec, type ModelSpec } from '../../catalog/models';
import type { Cell } from '../../domain/coords';
import { type CellMap, type Walls, labelPosition, roomTiles, walls } from '../../domain/plan';
import {
  type Box,
  CEILING_HEIGHT,
  CUT_HEIGHT,
  type Heading,
  type OpeningLike,
  type OpeningPlacement,
  type WallSides,
  boxesAbove,
  facingWalls,
  type ItemTransform,
  type Mount,
  type Vec3,
  cellBounds,
  itemTransform,
  openingPlacements,
  wallGeometry,
} from '../../domain/scene';
import { type FloorModel, type Model, itemFootprint, occupiedTiles } from '../../store/model';
import { type SceneSphere, boxSphere } from './camera';

export interface SceneItem {
  id: string;
  item: Item;
  mount: Mount;
  model: ModelSpec;
  transform: ItemTransform;
}

/** A placement whose note is missing: drawn as a ghost box (DESIGN 15.2). */
export interface SceneGhost {
  id: string;
  transform: ItemTransform;
}

export interface SceneRoom {
  roomId: string;
  name: string;
  color: string;
  tiles: Cell[];
  /** Label anchor on the floor, world metres. */
  label: Vec3;
}

export interface SceneLayout {
  floorId: string;
  tileSize: number;
  wallHeight: number;
  rooms: SceneRoom[];
  /** Wall edges and openings of this floor (wallMeshes splits them per heading). */
  segments: Walls;
  openings: OpeningLike[];
  /** All walls at `wallHeight`, and the window panes. */
  walls: Box[];
  glass: Box[];
  items: SceneItem[];
  ghosts: SceneGhost[];
  /** World box to fit the camera to. */
  bounds: { min: Vec3; max: Vec3 };
  /** Around the whole grid up to the ceiling: zoom limits and clipping planes come from it. */
  sphere: SceneSphere;
}

export function sceneLayout(model: Model, floor: FloorModel, wallHeight: number): SceneLayout {
  const ts = model.tileSize;
  const occupied = occupiedTiles(model, floor);
  const rooms: SceneRoom[] = [...roomTiles(floor.cells)].map(([roomId, tiles]) => {
    const room = model.rooms.get(roomId)!;
    const at = labelPosition(tiles, floor.cells, occupied);
    return {
      roomId,
      name: room.name,
      color: room.color,
      tiles,
      label: { x: at.x * ts, y: 0, z: at.y * ts },
    };
  });

  const openings = (model.snapshot.house?.openings ?? []).filter(
    (o) => o.floorId === floor.floor.id,
  );
  const segments = walls(floor.cells);
  const wg = wallGeometry(segments, openings, ts, wallHeight);

  const items: SceneItem[] = floor.items.flatMap((item) => {
    const loc = item.location;
    if (!loc) return [];
    // A placement may override the catalogue footprint (data contract §2).
    const spec = { ...placementSpec(item.type), footprint: itemFootprint(model, item) };
    const shape = modelSpec(item.type);
    return [
      {
        id: item.id,
        item,
        mount: spec.mount,
        model: shape,
        transform: itemTransform(loc, spec, shape, ts),
      },
    ];
  });

  const ghosts: SceneGhost[] = floor.ghosts.map((p) => {
    const spec = {
      ...placementSpec(null),
      footprint: p.footprint ?? placementSpec(null).footprint,
    };
    const loc = { floorId: p.floorId, roomId: null, x: p.x, y: p.y, rotation: p.rotation ?? 0 };
    return { id: p.itemId, transform: itemTransform(loc, spec, modelSpec(null), ts) };
  });

  const b = cellBounds(floor.cells, model.grid);
  return {
    floorId: floor.floor.id,
    tileSize: ts,
    wallHeight,
    rooms,
    segments,
    openings,
    walls: wg.walls,
    glass: wg.glass,
    items,
    ghosts,
    bounds: {
      min: { x: b.x0 * ts, y: 0, z: b.y0 * ts },
      max: {
        x: b.x1 * ts,
        y: Math.max(wallHeight, ...items.map((i) => itemTop(i.transform).y)),
        z: b.y1 * ts,
      },
    },
    sphere: gridSphere(model.grid, ts),
  };
}

export interface WallMeshes {
  /** One opaque mesh: every wall that hides nothing, and the low base of those that would. */
  solid: Box[];
  /** One translucent mesh: the upper part of walls facing the camera. */
  faded: Box[];
  /** Plain panes, drawn until the window model has loaded (and if it fails). */
  glass: Box[];
  /** Panes in faded walls: part of the faded mesh until the window model has loaded. */
  fadedGlass: Box[];
  /** Doors and windows to draw: their models fade with the wall they are in (by key). */
  openings: OpeningPlacement[];
  fadedOpenings: ReadonlySet<string>;
}

/**
 * Walls as drawn for a camera looking `heading`. Cut away (low), nothing hides anything. With
 * walls up, walls facing the camera keep a solid cut-height base, so rooms stay outlined, and
 * fade above it, so the rooms behind them stay visible (DESIGN §7.4, M2-03).
 */
export function wallMeshes(
  layout: SceneLayout,
  cells: CellMap,
  heading: Heading,
  /** Home look (D41): walls in halves, one per side, tagged with what each faces. */
  sides?: WallSides,
): WallMeshes {
  const ts = layout.tileSize;
  const openings = openingPlacements(
    layout.segments,
    layout.openings,
    cells,
    ts,
    layout.wallHeight,
  );
  if (layout.wallHeight <= CUT_HEIGHT)
    return {
      solid: sides
        ? wallGeometry(layout.segments, layout.openings, ts, layout.wallHeight, sides).walls
        : layout.walls,
      faded: [],
      glass: layout.glass,
      fadedGlass: [],
      openings,
      fadedOpenings: new Set(),
    };
  const { facing, other } = facingWalls(layout.segments, cells, heading);
  const back = wallGeometry(other, layout.openings, ts, layout.wallHeight, sides);
  const front = wallGeometry(facing, layout.openings, ts, layout.wallHeight, sides);
  const base = wallGeometry(facing, layout.openings, ts, CUT_HEIGHT, sides);
  const onFacing = openingPlacements(facing, layout.openings, cells, ts, layout.wallHeight);
  return {
    solid: [...back.walls, ...base.walls],
    faded: boxesAbove(front.walls, CUT_HEIGHT),
    glass: back.glass,
    fadedGlass: front.glass,
    openings,
    fadedOpenings: new Set(onFacing.map((o) => o.key)),
  };
}

/** One sphere per grid (not per floor or wall height), so the zoom limits never jump. */
const spheres = new Map<string, SceneSphere>();
function gridSphere(grid: { width: number; depth: number }, ts: number): SceneSphere {
  const key = `${grid.width}x${grid.depth}@${ts}`;
  let s = spheres.get(key);
  if (!s) {
    s = boxSphere({
      min: { x: 0, y: 0, z: 0 },
      max: { x: Math.max(1, grid.width) * ts, y: CEILING_HEIGHT, z: Math.max(1, grid.depth) * ts },
    });
    spheres.set(key, s);
  }
  return s;
}

/** Top centre of an item's model, where its status badge and name float. */
export const itemTop = (t: ItemTransform): Vec3 => ({
  x: t.position.x,
  y: t.position.y + t.size.y / 2,
  z: t.position.z,
});
