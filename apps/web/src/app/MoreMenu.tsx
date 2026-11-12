/**
 * The "⋯" menu at the end of the top bar (D46): things done now and then (printing, the
 * calendar link, the theme), kept out of the views people use every day. A disclosure, not an
 * ARIA menu: plain links and buttons in Tab order; Esc or a click outside closes it.
 */
import { useEffect, useRef, useState } from 'react';
import { CalendarDialog } from '../features/attention/CalendarDialog';
import { printPath } from '../features/print/pages';
import { useData } from '../store/data';
import { useSearchResults } from '../store/search';
import { type Theme, useUi } from '../store/ui';
import { EMERGENCY } from '../strings/emergency';
import { STICKERS } from '../strings/stickers';

const THEMES: [Theme, string][] = [
  ['auto', 'Auto'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

export function MoreMenu() {
  const [open, setOpen] = useState(false);
  const [calendar, setCalendar] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const model = useData((s) => s.model);
  const search = useSearchResults();
  // While searching, the stickers start with the items that match (D45).
  const stickerIds =
    search.active && model
      ? [...model.items.values()].filter((i) => search.matches.has(i.id)).map((i) => i.id)
      : undefined;

  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);

  return (
    // Esc closes the menu and puts focus back on its button (keydown delegation).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={root}
      className="more"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className="ghost more-button"
        aria-expanded={open}
        aria-controls="more-menu"
        aria-label="More"
        title="More"
        onClick={() => setOpen((o) => !o)}
      >
        <svg className="ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && (
        <div id="more-menu" className="more-pop">
          <ul>
            <li>
              <a href={printPath('stickers', stickerIds)}>{STICKERS.open}</a>
            </li>
            <li>
              <a href="/print/emergency">{EMERGENCY.open}</a>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  // Focus the menu button first: the dialog returns focus to it when it closes.
                  button.current?.focus();
                  setOpen(false);
                  setCalendar(true);
                }}
              >
                Add to your calendar
              </button>
            </li>
          </ul>
          <div className="more-theme">
            <span id="more-theme-label">Theme</span>
            <div className="seg" role="group" aria-labelledby="more-theme-label">
              {THEMES.map(([t, label]) => (
                <button
                  key={t}
                  type="button"
                  className={theme === t ? 'on' : undefined}
                  aria-pressed={theme === t}
                  onClick={() => setTheme(t)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {calendar && <CalendarDialog onClose={() => setCalendar(false)} />}
    </div>
  );
}
