/**
 * Loads each GLB once per page (one fetch per type, every item of that type shares the
 * template) and remembers failures: a model that 404s or doesn't parse is drawn as the box
 * for the rest of the session. A network error or 5xx is retried once, never more (M2-05).
 * React reads it through useSyncExternalStore (useModel).
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { type GlbSource, modelSource } from './manifest';
import { proceduralModel } from './procedural';
import { type ModelTemplate, templateFromScene } from './template';

export type ModelState =
  { status: 'loading' } | { status: 'ready'; template: ModelTemplate } | { status: 'failed' };

/** What an item of a type is drawn as right now (test hook, e2e). */
export type ModelStatus = 'loading' | 'glb' | 'procedural' | 'box';

const RETRY_MS = 600;

class Retryable extends Error {}

async function fetchAndParse(url: string): Promise<Object3D> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Retryable(String(e));
  }
  if (res.status >= 500) throw new Retryable(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const gltf = await new GLTFLoader().parseAsync(await res.arrayBuffer(), '');
  return gltf.scene;
}

let loadScene: (url: string) => Promise<Object3D> = fetchAndParse;
let retryMs = RETRY_MS;

const states = new Map<string, ModelState>();
/** Stable snapshots for procedural types (useSyncExternalStore compares by identity). */
const procedural = new Map<string, ModelState>();
const listeners = new Set<() => void>();
const LOADING: ModelState = { status: 'loading' };

function set(url: string, s: ModelState) {
  states.set(url, s);
  for (const l of listeners) l();
}

async function load(src: GlbSource): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const scene = await loadScene(src.url);
      set(src.url, { status: 'ready', template: templateFromScene(scene, src.yaw) });
      return;
    } catch (e) {
      if (e instanceof Retryable && attempt === 0) {
        await new Promise((r) => setTimeout(r, retryMs));
        continue;
      }
      set(src.url, { status: 'failed' });
      return;
    }
  }
}

/** Start loading `src` unless it is loading, loaded or has failed. */
export function ensureLoaded(src: GlbSource): void {
  if (states.has(src.url)) return;
  states.set(src.url, LOADING);
  void load(src);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The model state of a type (procedural types are ready at once). */
export function modelState(type: string | null | undefined): ModelState {
  const src = modelSource(type);
  if (src.kind === 'procedural') {
    let s = procedural.get(src.type);
    if (!s)
      procedural.set(src.type, (s = { status: 'ready', template: proceduralModel(src.type) }));
    return s;
  }
  return states.get(src.url) ?? LOADING;
}

export function modelStatus(type: string | null | undefined): ModelStatus {
  const s = modelState(type);
  return s.status === 'ready' ? s.template.kind : s.status === 'failed' ? 'box' : 'loading';
}

/** A GLB that isn't an item type (door and window parts), loading it on first use. */
export function useGlb(src: GlbSource): ModelState {
  const state = useSyncExternalStore(subscribe, () => states.get(src.url) ?? LOADING);
  useEffect(() => ensureLoaded(src), [src]);
  return state;
}

/** The model for `type`, loading it on first use. */
export function useModel(type: string | null | undefined): ModelState {
  const src = modelSource(type);
  const state = useSyncExternalStore(subscribe, () => modelState(type));
  useEffect(() => {
    if (src.kind === 'glb') ensureLoaded(src);
    // `src` is derived from `type`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);
  return state;
}

/** Tests only: replace the network loader (null: fetch), set the retry delay, forget all loads. */
export function setSceneLoaderForTests(
  loader: ((url: string) => Promise<Object3D>) | null,
  retryDelayMs = 0,
): void {
  loadScene = loader ?? fetchAndParse;
  retryMs = retryDelayMs;
  states.clear();
}
