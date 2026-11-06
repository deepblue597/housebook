/**
 * A model ready to draw: flat parts (geometry already in the model's frame, front +z) plus
 * their bounds. One template per type is shared by every item of that type; items only add a
 * transform and their own materials, so geometry is never copied per item.
 */
import type { BufferGeometry } from 'three';
import { Box3, Color, Matrix4, Mesh, type Object3D, Vector3 } from 'three';
import type { Bounds, Yaw } from './normalise';

export interface ModelPart {
  name: string;
  geometry: BufferGeometry;
  /** sRGB hex colour of the part. */
  color: string;
  /** Draw the hover/selection outline around this part (the large ones). */
  outline: boolean;
}

export type ModelKind = 'glb' | 'procedural';

export interface ModelTemplate {
  kind: ModelKind;
  parts: ModelPart[];
  bounds: Bounds;
}

/** Parts at least this share of the largest part's volume get the outline (not knobs). */
const OUTLINE_SHARE = 0.2;

export function makeTemplate(
  kind: ModelKind,
  parts: Array<Omit<ModelPart, 'outline'> & { outline?: boolean }>,
): ModelTemplate {
  const box = new Box3();
  const vol = parts.map((p) => {
    p.geometry.computeBoundingBox();
    const b = p.geometry.boundingBox!;
    box.union(b);
    const s = b.getSize(new Vector3());
    return s.x * s.y * s.z;
  });
  const biggest = Math.max(...vol, 0);
  return {
    kind,
    parts: parts.map((p, i) => ({
      ...p,
      outline: p.outline ?? vol[i]! >= biggest * OUTLINE_SHARE,
    })),
    bounds: {
      min: { x: box.min.x, y: box.min.y, z: box.min.z },
      max: { x: box.max.x, y: box.max.y, z: box.max.z },
    },
  };
}

/** Flatten a loaded glTF scene into parts, turned by `yaw` so the model faces +z. */
export function templateFromScene(root: Object3D, yaw: Yaw): ModelTemplate {
  root.updateMatrixWorld(true);
  const turn = new Matrix4().makeRotationY((yaw * Math.PI) / 180);
  const parts: Array<Omit<ModelPart, 'outline'>> = [];
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const g = (o.geometry as BufferGeometry).clone();
    g.applyMatrix4(new Matrix4().multiplyMatrices(turn, o.matrixWorld));
    const m = (Array.isArray(o.material) ? o.material[0] : o.material) as {
      color?: Color;
      name?: string;
    };
    parts.push({
      // Kit models have one primitive per material: the material says what the part is.
      name: m?.name || o.name || `part${parts.length}`,
      geometry: g,
      color: `#${(m?.color ?? new Color('#cccccc')).getHexString()}`,
    });
  });
  if (parts.length === 0) throw new Error('model has no meshes');
  return makeTemplate('glb', parts);
}
