import { render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { type CameraState, project } from './camera';
import { type Anchor, type OverlayHandle, SceneOverlays } from './SceneOverlays';

const vp = { width: 640, height: 480 };
const cam: CameraState = { x: 4, z: 3, zoom: 40, angle: 0 };
const anchors: Anchor[] = [
  { key: 'room:a', world: { x: 2, y: 0.02, z: 1 }, className: 'label3d', text: 'Kitchen' },
  { key: 'badge:i', world: { x: 5, y: 1.2, z: 4 }, className: 'badge3d bad', text: '!' },
];

const translate = (el: Element) => {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec((el as HTMLElement).style.transform);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};

describe('3D overlays', () => {
  it('places labels and badges where the camera projects their anchors', () => {
    const handle = createRef<OverlayHandle>();
    const { container } = render(
      <SceneOverlays anchors={anchors} handle={handle} view={() => ({ cam, vp })} />,
    );
    const layer = container.querySelector('.overlay3d')!;
    expect(layer).toHaveAttribute('aria-hidden', 'true');
    for (const a of anchors) {
      const el = layer.querySelector(`[data-anchor="${a.key}"]`)!;
      expect(el).toHaveTextContent(a.text);
      const want = project(cam, vp, a.world);
      expect(translate(el)!.x).toBeCloseTo(want.x, 0);
      expect(translate(el)!.y).toBeCloseTo(want.y, 0);
    }
    // A camera move repositions without re-rendering.
    const moved = { ...cam, angle: -90, zoom: 80 };
    handle.current!.place(moved, vp);
    const el = layer.querySelector('[data-anchor="badge:i"]')!;
    const want = project(moved, vp, anchors[1]!.world);
    expect(translate(el)!.x).toBeCloseTo(want.x, 0);
    expect(translate(el)!.y).toBeCloseTo(want.y, 0);
  });

  it('waits for the first frame before placing anything', () => {
    const { container } = render(
      <SceneOverlays anchors={anchors} handle={createRef()} view={() => null} />,
    );
    expect(translate(container.querySelector('[data-anchor="room:a"]')!)).toBeNull();
  });
});
