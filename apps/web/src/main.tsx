import '@fontsource/archivo-narrow/500.css';
import '@fontsource/archivo-narrow/600.css';
import '@fontsource/archivo-narrow/700.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { startRouter } from './app/router';
import { installTestHook } from './app/testHook';
import { preloadMarkdown } from './features/details/markdownLoader';
import { LazyPrintPage } from './features/print/LazyPrintPage';
import { printPageOf } from './features/print/pages';
import { useData } from './store/data';
import { startSync } from './store/sync';

// Pages made for paper (D44, D45) stand alone: no live sync, no router.
const printPage = printPageOf(location.pathname);

installTestHook();
void useData.getState().load();
if (!printPage) {
  startRouter();
  void useData.getState().loadMe();
  startSync();
  // Notes are opened often; fetch the Markdown chunk once the shell is idle.
  (window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500)))(() =>
    preloadMarkdown(),
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{printPage ? <LazyPrintPage page={printPage} /> : <App />}</StrictMode>,
);
