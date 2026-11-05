/** Camera state → three's orthographic camera (used by CameraRig, verified in camera.test.ts). */
import type { OrthographicCamera } from 'three';
import { type CameraState, type SceneSphere, cameraDepth, cameraPose } from './camera';

export function applyCamera(camera: OrthographicCamera, c: CameraState, scene: SceneSphere): void {
  const { distance, near, far } = cameraDepth(c, scene);
  const { position, target } = cameraPose(c, distance);
  camera.position.set(...position);
  camera.up.set(0, 1, 0);
  camera.lookAt(...target);
  camera.zoom = c.zoom;
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
