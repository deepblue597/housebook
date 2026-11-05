import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetWebglProbe, webglAvailable } from './webgl';

describe('WebGL probe', () => {
  afterEach(resetWebglProbe);

  it('is false when the browser has no WebGL, and never throws', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(webglAvailable()).toBe(false);
    resetWebglProbe();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(webglAvailable()).toBe(false);
  });

  it('is true with a context, frees the probe context, and is cached', () => {
    const loseContext = vi.fn();
    const ctx = { getExtension: () => ({ loseContext }) };
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      // `never`: getContext is overloaded per context kind (webgl2, webgpu, …).
      .mockReturnValue(ctx as never);
    expect(webglAvailable()).toBe(true);
    expect(loseContext).toHaveBeenCalledOnce();
    expect(webglAvailable()).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });
});
