/**
 * The model of one item, in its own frame: centred on the origin, front facing +z, `size` in
 * metres. Milestone 2 draws a tinted box with a darker front panel (so rotation is visible);
 * milestone 3 swaps in the catalogue's GLB here and keeps the box as the fallback. Position,
 * rotation, picking, badges and labels stay in ItemNode, so the swap touches only this file.
 */
import { Outlines } from '@react-three/drei/core/Outlines';
import type { Vec3 } from '../../domain/scene';

export type Highlight = 'none' | 'hover' | 'selected';

export interface ItemModelProps {
  /** Catalogue type key (unused by the placeholder; the GLB lookup will need it). */
  type: string | null;
  size: Vec3;
  tint: string;
  highlight: Highlight;
  /** Search is active and this item doesn't match. */
  dim: boolean;
  /** Outline colour for hover and selection. */
  accent: string;
}

export function ItemModel({ size, tint, highlight, dim, accent }: ItemModelProps) {
  const panel = { w: size.x * 0.8, h: size.y * 0.7, d: Math.min(0.02, size.z * 0.2) };
  return (
    <group name="model">
      <mesh name="body">
        <boxGeometry args={[size.x, size.y, size.z]} />
        <meshLambertMaterial
          color={tint}
          transparent={dim}
          opacity={dim ? 0.25 : 1}
          emissive={accent}
          emissiveIntensity={highlight === 'selected' ? 0.35 : highlight === 'hover' ? 0.15 : 0}
        />
        {highlight !== 'none' && !dim && (
          <Outlines
            thickness={highlight === 'selected' ? 0.045 : 0.025}
            color={accent}
            renderOrder={1}
          />
        )}
      </mesh>
      {/* Front marker: shows which way the item faces (rotation). */}
      <mesh name="front" position={[0, 0, size.z / 2 + panel.d / 2]}>
        <boxGeometry args={[panel.w, panel.h, panel.d]} />
        <meshLambertMaterial
          color="#33414a"
          transparent
          opacity={dim ? 0.1 : 0.45}
          depthWrite={!dim}
        />
      </mesh>
    </group>
  );
}
