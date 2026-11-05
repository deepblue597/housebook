/** The Markdown renderer is a lazy chunk; one loader so preloading and React.lazy share it. */
export const loadMarkdown = () => import('./MarkdownBody');

/** Start fetching the chunk early (idle time after first load). */
export const preloadMarkdown = (): void => void loadMarkdown();
