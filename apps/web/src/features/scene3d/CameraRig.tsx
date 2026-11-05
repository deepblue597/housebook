/**
 * Applies the camera state to three's orthographic camera. With frameloop="demand" a frame is
 * only drawn when something asks for one; while easing towards a new goal (rotate, focus, fit)
 * the rig asks for the next frame itself. Reduced motion: jump straight to the goal.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useLayoutEffect, useRef } from 'react';
import type { OrthographicCamera } from 'three';
import {
  type CameraState,
  type SceneSphere,
  type Viewport,
  sameCamera,
  stepToward,
} from './camera';
import { applyCamera } from './rig';

export interface CameraRigProps {
  goal: CameraState;
  /** Jump instead of easing (drag, wheel, first fit, reduced motion). */
  instant: boolean;
  /** Everything that can be drawn, so the clipping planes never cut it (large grids). */
  scene: SceneSphere;
  /** Called after the camera is updated for a frame: what it shows, where it is heading, at
   * which canvas size, and whether it is still easing. */
  onFrame?: (current: CameraState, goal: CameraState, size: Viewport, moving: boolean) => void;
}

export function CameraRig({ goal, instant, scene, onFrame }: CameraRigProps) {
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  const invalidate = useThree((s) => s.invalidate);
  const current = useRef<CameraState>(goal);

  useLayoutEffect(() => {
    if (instant) {
      current.current = goal;
      applyCamera(camera, goal, scene);
    }
    invalidate();
  }, [goal, instant, scene, camera, invalidate]);

  useFrame((state, dt) => {
    let moving = false;
    if (!sameCamera(current.current, goal)) {
      const step = stepToward(current.current, goal, Math.min(dt, 1 / 30));
      current.current = step.state;
      moving = !step.done;
      if (moving) invalidate();
    }
    applyCamera(camera, current.current, scene);
    onFrame?.(
      current.current,
      goal,
      { width: state.size.width, height: state.size.height },
      moving,
    );
  });

  return null;
}
