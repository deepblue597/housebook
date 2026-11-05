/**
 * Can this browser draw the 3D view? Checked once with a throwaway canvas, without loading
 * three.js. Blocked or missing WebGL (old devices, hardened browsers, some VMs) keeps the 2D
 * plan as the only choice.
 */
let cached: boolean | null = null;

export function webglAvailable(): boolean {
  if (cached !== null) return cached;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    cached = !!gl;
    // Free the probe context right away; browsers cap the number of live contexts.
    (gl?.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
  } catch {
    cached = false;
  }
  return cached;
}

/** Tests only. */
export const resetWebglProbe = (): void => {
  cached = null;
};
