/**
 * The model of one item, in its own frame: centred on the origin, front facing +z, `size` in
 * metres (DESIGN §7.4, §7.5). A catalogue model (CC0 GLB or a procedural one) is fitted into
 * that box by mount (models/normalise.ts); while a GLB loads, and for good if it fails, the
 * item is drawn as the tinted box with a darker front panel. Position, rotation, picking,
 * badges and labels stay in ItemNode.
 */
import { Outlines } from '@react-three/drei/core/Outlines';
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { blend, parseHex, toHex } from '../../domain/color';
import type { Mount, Vec3 } from '../../domain/scene';
import { useModel } from './models/library';
import { fitModel } from './models/normalise';
import type { ModelTemplate } from './models/template';

export type Highlight = 'none' | 'hover' | 'selected';

export interface ItemModelProps {
  /** Catalogue type key or alias (unknown → the neutral model). */
  type: string | null;
  mount: Mount;
  size: Vec3;
  tint: string;
  highlight: Highlight;
  /** Search is active and this item doesn't match. */
  dim: boolean;
  /** Outline colour for hover and selection. */
  accent: string;
}

/** How far a model's own colours lean towards the type tint: a hint, not a repaint. */
export const TINT_SHARE = 0.18;
const DIM_OPACITY = 0.25;
/** Render order of a dimmed model's colour pass, after its depth prepass (DIM_ORDER − 1). */
const DIM_ORDER = 2;
const OUTLINE = { selected: 0.045, hover: 0.025 } as const;

const mix = (base: string, tint: string, share: number) => {
  const [a, b] = [parseHex(base), parseHex(tint)];
  return a && b ? toHex(blend(b, a, share)) : base;
};

// Materials are keyed by `dim`: three compiles an opaque material's shader with alpha fixed at
// 1, so flipping `transparent` on a live material would never blend (it needs a new program).
const emissive = (h: Highlight) => (h === 'selected' ? 0.35 : h === 'hover' ? 0.15 : 0);

export function ItemModel(props: ItemModelProps) {
  const state = useModel(props.type);
  const invalidate = useThree((s) => s.invalidate);
  // frameloop="demand": draw once the model has arrived (or failed over to the box).
  useEffect(() => invalidate(), [state, invalidate]);
  return state.status === 'ready' ? (
    <FittedModel template={state.template} {...props} />
  ) : (
    <BoxModel {...props} />
  );
}

function FittedModel({
  template,
  mount,
  size,
  tint,
  highlight,
  dim,
  accent,
}: ItemModelProps & { template: ModelTemplate }) {
  const fit = useMemo(() => fitModel(template.bounds, size, mount), [template, size, mount]);
  const colors = useMemo(
    () => template.parts.map((p) => mix(p.color, tint, TINT_SHARE)),
    [template, tint],
  );
  return (
    <group
      name="model"
      userData={{ kind: template.kind }}
      position={[fit.offset.x, fit.offset.y, fit.offset.z]}
      scale={fit.scale}
    >
      {/* Dimmed: write the model's depth first (no colour), so only its front-most surface is
          blended. Otherwise inner parts (a fridge's shelves) stack up and it stays opaque. */}
      {dim &&
        template.parts.map((p, i) => (
          <mesh
            key={`depth:${i}`}
            name="depth"
            geometry={p.geometry}
            renderOrder={DIM_ORDER - 1}
            raycast={() => null}
          >
            <meshBasicMaterial colorWrite={false} transparent />
          </mesh>
        ))}
      {template.parts.map((p, i) => (
        <mesh
          key={`${i}:${p.name}`}
          name={p.name}
          geometry={p.geometry}
          renderOrder={dim ? DIM_ORDER : 0}
        >
          <meshLambertMaterial
            key={dim ? 'dim' : 'solid'}
            color={colors[i]}
            transparent={dim}
            opacity={dim ? DIM_OPACITY : 1}
            depthWrite={!dim}
            emissive={accent}
            emissiveIntensity={emissive(highlight)}
          />
          {p.outline && highlight !== 'none' && !dim && (
            // Outlines are in the model's (scaled) units: undo the scale.
            <Outlines thickness={OUTLINE[highlight] / fit.scale} color={accent} renderOrder={1} />
          )}
        </mesh>
      ))}
    </group>
  );
}

/** The fallback: a tinted box with a darker front panel (shows which way the item faces). */
function BoxModel({ size, tint, highlight, dim, accent }: ItemModelProps) {
  const panel = { w: size.x * 0.8, h: size.y * 0.7, d: Math.min(0.02, size.z * 0.2) };
  return (
    <group name="model" userData={{ kind: 'box' }}>
      <mesh name="body">
        <boxGeometry args={[size.x, size.y, size.z]} />
        <meshLambertMaterial
          key={dim ? 'dim' : 'solid'}
          color={tint}
          transparent={dim}
          opacity={dim ? DIM_OPACITY : 1}
          emissive={accent}
          emissiveIntensity={emissive(highlight)}
        />
        {highlight !== 'none' && !dim && (
          <Outlines thickness={OUTLINE[highlight]} color={accent} renderOrder={1} />
        )}
      </mesh>
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
