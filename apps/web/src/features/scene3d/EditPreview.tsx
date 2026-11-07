/**
 * Edit mode in the 3D view: the grid's outline and the active tool's preview (the same
 * rectangles as the 2D plan, from the editor's `usePreviewRects`), as flat translucent boxes.
 * Nothing here is pickable.
 */
import { useEffect, useMemo } from 'react';
import { BufferAttribute, BufferGeometry } from 'three';
import { type PreviewRect, usePreviewRects } from '../editor';
import { useEditor } from '../../store/editor';
import type { ScenePalette } from './palette';

const ERASE = '#d0453a';
const noRaycast = () => null;

function Bounds({
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
    const [w, d] = [width * ts, depth * ts];
    const geo = new BufferGeometry();
    const y = 0.015;
    geo.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([0, y, 0, w, y, 0, w, y, 0, w, y, d, w, y, d, 0, y, d, 0, y, d, 0, y, 0]),
        3,
      ),
    );
    return geo;
  }, [width, depth, ts]);
  useEffect(() => () => g.dispose(), [g]);
  return (
    <lineSegments name="edit-bounds" geometry={g} raycast={noRaycast}>
      <lineBasicMaterial color={color} />
    </lineSegments>
  );
}

function PreviewBox({ p, ts, palette }: { p: PreviewRect; ts: number; palette: ScenePalette }) {
  const { x, y, w, h } = p.rect;
  const tall = p.tone === 'item' ? 0.5 : 0.04;
  const color =
    p.tone === 'erase' ? ERASE : p.tone === 'paint' ? (p.color ?? palette.accent) : palette.accent;
  return (
    <mesh
      name={`preview:${p.tone}`}
      position={[(x + w / 2) * ts, tall / 2 + 0.01, (y + h / 2) * ts]}
      raycast={noRaycast}
    >
      <boxGeometry args={[w * ts * 0.98, tall, h * ts * 0.98]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={p.tone === 'cursor' ? 0.25 : 0.45}
        depthWrite={false}
      />
    </mesh>
  );
}

export function EditPreview({
  floorId,
  grid,
  ts,
  palette,
}: {
  floorId: string;
  grid: { width: number; depth: number };
  ts: number;
  palette: ScenePalette;
}) {
  const editing = useEditor((s) => s.mode === 'edit');
  const rects = usePreviewRects(floorId);
  if (!editing) return null;
  return (
    <group name="edit-preview">
      <Bounds width={grid.width} depth={grid.depth} ts={ts} color={palette.accent} />
      {rects.map((p, i) => (
        <PreviewBox key={i} p={p} ts={ts} palette={palette} />
      ))}
    </group>
  );
}
