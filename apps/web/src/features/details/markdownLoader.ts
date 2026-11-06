/** The Markdown renderer is a lazy chunk; one loader so preloading and React.lazy share it. */
const importChunk = () => import('./MarkdownBody');
type Chunk = ReturnType<typeof importChunk>;

let pending: Chunk | null = null;
/** URL of the chunk after a failed import; browsers keep the failure per URL. */
let failedUrl: string | null = null;
let attempt = 0;
let loaded = false;

/** True once the renderer chunk has loaded (an error after that is a render error). */
export const markdownLoaded = (): boolean => loaded;

/**
 * A failed import (offline, a flaky network) is forgotten, so the next call fetches again. The
 * browser caches a failed module fetch for its URL, so a retry asks for the same file with a
 * query string (taken from the error message where the browser names the URL).
 */
export const loadMarkdown = (): Chunk => {
  pending ??= (
    failedUrl
      ? (import(/* @vite-ignore */ `${failedUrl}?retry=${++attempt}`) as Chunk)
      : importChunk()
  ).then(
    (m) => {
      loaded = true;
      return m;
    },
    (e: unknown) => {
      pending = null;
      const url = /\bhttps?:\/\/\S+?\.m?js\b/.exec(e instanceof Error ? e.message : String(e));
      if (url) failedUrl = url[0];
      throw e;
    },
  );
  return pending;
};

/** Start fetching the chunk early (idle time after first load). */
export const preloadMarkdown = (): void => {
  loadMarkdown().catch(() => undefined);
};
