/**
 * Finish textures for the 3D home look (D42): each loads once, the first time a view draws it
 * (so nothing is fetched while the home look is off), and repeats at its real-world size. The
 * meshes' UVs are in metres (domain/scene.ts), so `repeat = 1 / size`. A texture that fails to
 * load is drawn as the finish's colour for the rest of the session.
 */
import { useThree } from '@react-three/fiber';
import { useEffect, useSyncExternalStore } from 'react';
import { RepeatWrapping, SRGBColorSpace, type Texture, TextureLoader } from 'three';
import type { FinishTexture } from '../../catalog/finishes';

type State = Texture | 'loading' | 'failed';

const states = new Map<string, State>();
const listeners = new Set<() => void>();
const keyOf = (t: FinishTexture) => `${t.url}@${t.size[0]}x${t.size[1]}`;

function set(key: string, s: State) {
  states.set(key, s);
  for (const l of listeners) l();
}

type Loader = (url: string, ok: (t: Texture) => void, fail: () => void) => void;
const threeLoader: Loader = (url, ok, fail) => {
  new TextureLoader().load(url, ok, undefined, fail);
};
let load: Loader = threeLoader;

function ensure(t: FinishTexture) {
  const key = keyOf(t);
  if (states.has(key)) return;
  states.set(key, 'loading');
  load(
    t.url,
    (tex) => {
      tex.wrapS = tex.wrapT = RepeatWrapping;
      tex.repeat.set(1 / t.size[0], 1 / t.size[1]);
      tex.colorSpace = SRGBColorSpace;
      tex.anisotropy = 4; // seen at a slant from the camera: keeps the planks sharp
      tex.needsUpdate = true;
      set(key, tex);
    },
    () => set(key, 'failed'),
  );
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The texture, or null while it loads (or if it failed): draw the finish's colour then. */
export function useFinishTexture(t: FinishTexture | undefined): Texture | null {
  const key = t ? keyOf(t) : '';
  const state = useSyncExternalStore(subscribe, () => (key ? states.get(key) : undefined));
  const invalidate = useThree((s) => s.invalidate);
  // frameloop="demand": draw again once the texture has arrived (or failed over to colour).
  useEffect(() => invalidate(), [state, invalidate]);
  useEffect(() => {
    if (t) ensure(t);
    // `t` is identified by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state && state !== 'loading' && state !== 'failed' ? state : null;
}

/** Tests only: replace the loader, forget every texture. */
export function setTextureLoaderForTests(loader: Loader | null): void {
  load = loader ?? threeLoader;
  states.clear();
}
