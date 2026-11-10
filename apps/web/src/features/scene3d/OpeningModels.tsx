/**
 * Door and window models in the wall gaps (D37): a frame with an open leaf per door (the kit's
 * front door on exterior walls), a frame with its pane per window. Display only: they never
 * take a click, so the floor and items behind them stay pickable. Until the models have loaded
 * (or if they fail) the gaps and the plain panes of `wallGeometry` show the openings alone.
 */
import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { DoubleSide, Plane, Vector3 } from 'three';
import type { OpeningPlacement } from '../../domain/scene';
import { useGlb } from './models/library';
import { OPENING_MODELS } from './models/manifest';
import { type Stretch, doorFit, windowFit } from './models/openingFit';
import type { ModelTemplate } from './models/template';

/** Glass parts of the kit models (by material name) are see-through. */
const GLASS_OPACITY = 0.45;

export interface OpeningModelsProps {
  openings: readonly OpeningPlacement[];
  /** Keys of the openings in walls drawn faded ("walls up", facing the camera). */
  faded: ReadonlySet<string>;
  fadedOpacity: number;
  /** Wall height shown: doors are clipped to it when the walls are cut away. */
  clipY: number | null;
}

function Parts({
  template,
  fit,
  faded,
  fadedOpacity,
  clip,
}: {
  template: ModelTemplate;
  fit: Stretch;
  faded: boolean;
  fadedOpacity: number;
  clip: Plane[] | null;
}) {
  return (
    <group
      position={[fit.offset.x, fit.offset.y, fit.offset.z]}
      scale={[fit.scale.x, fit.scale.y, fit.scale.z]}
    >
      {template.parts.map((p, i) => {
        const glass = p.name === 'glass';
        const opacity = (glass ? GLASS_OPACITY : 1) * (faded ? fadedOpacity : 1);
        return (
          <mesh key={`${i}:${p.name}`} name={p.name} geometry={p.geometry} raycast={() => null}>
            <meshLambertMaterial
              // A new material when transparency flips (three bakes it into the shader).
              key={opacity < 1 ? 'clear' : 'solid'}
              color={p.color}
              transparent={opacity < 1}
              opacity={opacity}
              depthWrite={opacity === 1}
              side={glass ? DoubleSide : undefined}
              clippingPlanes={clip}
            />
          </mesh>
        );
      })}
    </group>
  );
}

export function OpeningModels({ openings, faded, fadedOpacity, clipY }: OpeningModelsProps) {
  const frame = useGlb(OPENING_MODELS.doorFrame);
  const leaf = useGlb(OPENING_MODELS.doorLeaf);
  const frontLeaf = useGlb(OPENING_MODELS.frontDoorLeaf);
  const pane = useGlb(OPENING_MODELS.window);
  const invalidate = useThree((s) => s.invalidate);
  // frameloop="demand": draw once a model has arrived.
  useEffect(() => invalidate(), [frame, leaf, frontLeaf, pane, invalidate]);
  // Keep what is below clipY: −y + clipY ≥ 0.
  const clip = useMemo(
    () => (clipY === null ? null : [new Plane(new Vector3(0, -1, 0), clipY)]),
    [clipY],
  );

  return (
    <group name="openings">
      {openings.map((o) => {
        const isFaded = faded.has(o.key);
        const common = { faded: isFaded, fadedOpacity };
        let body = null;
        if (o.kind === 'window') {
          if (pane.status !== 'ready') return null;
          body = (
            <Parts
              template={pane.template}
              fit={windowFit(pane.template.bounds, o)}
              clip={null}
              {...common}
            />
          );
        } else {
          const l = o.exterior ? frontLeaf : leaf;
          if (frame.status !== 'ready' || l.status !== 'ready') return null;
          const fit = doorFit(frame.template.bounds, l.template.bounds, o);
          body = (
            <>
              <Parts template={frame.template} fit={fit.frame} clip={clip} {...common} />
              <group
                position={[fit.hinge.x, 0, fit.hinge.z]}
                rotation={[0, fit.hinge.rotationY, 0]}
              >
                <Parts template={l.template} fit={fit.leaf} clip={clip} {...common} />
              </group>
            </>
          );
        }
        return (
          <group
            key={o.key}
            name={`${o.kind}:${o.key}`}
            position={[o.x, 0, o.z]}
            rotation={[0, o.rotationY, 0]}
          >
            {body}
          </group>
        );
      })}
    </group>
  );
}
