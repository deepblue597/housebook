import { useEffect } from 'react';
import { DetailsPanel } from '../features/details/DetailsPanel';
import { ListView } from '../features/list/ListView';
import { PlanView } from '../features/plan2d/PlanView';
import { SearchBox } from '../features/search/SearchBox';
import { readOnlyNotice } from '../components/houseNotice';
import { useData } from '../store/data';
import { useHouseProblems } from '../store/problems';
import { type View, useUi } from '../store/ui';
import { NEXT_THEME, useApplyTheme } from './theme';

function ViewToggle() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const options: [View, string][] = [
    ['plan', 'Plan'],
    ['list', 'List'],
  ];
  return (
    <div className="seg" role="group" aria-label="View">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          className={view === v ? 'on' : undefined}
          aria-pressed={view === v}
          onClick={() => setView(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const THEME_ICON = {
  auto: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
    </>
  ),
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </>
  ),
  dark: <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" />,
};

function ThemeToggle() {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const label = `Theme: ${theme}`;
  return (
    <button
      type="button"
      className="ghost theme"
      onClick={() => setTheme(NEXT_THEME[theme])}
      title={label}
      aria-label={`${label}. Change theme`}
    >
      <svg className="ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        {THEME_ICON[theme]}
      </svg>
    </button>
  );
}

/** Small, unobtrusive: the full problems panel arrives with editing (milestone 4). */
function ProblemsIndicator({ count }: { count: number }) {
  if (count === 0) return null;
  const text = `${count} data ${count === 1 ? 'problem' : 'problems'}`;
  return (
    <a
      className="problems"
      href="/api/problems"
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${text}, opens the integrity report`}
      title={`${text} (opens the integrity report)`}
    >
      <span aria-hidden="true">⚠ {count}</span>
    </a>
  );
}

function ReadOnlyBanner({
  schemaVersion,
  etag,
}: {
  schemaVersion: number | null;
  etag: string | null;
}) {
  const problems = useHouseProblems(true, etag);
  const notice = readOnlyNotice(problems, schemaVersion);
  return (
    <p className="banner" role="note" data-reason={notice.reason}>
      {notice.text}
      {notice.detail && <small className="detail">{notice.detail}</small>}
    </p>
  );
}

function Banners() {
  const model = useData((s) => s.model);
  const error = useData((s) => s.error);
  const loadedAt = useData((s) => s.loadedAt);
  const load = useData((s) => s.load);
  return (
    <>
      {model?.snapshot.houseReadOnly && (
        <ReadOnlyBanner
          schemaVersion={model.snapshot.houseSchemaVersion}
          etag={model.snapshot.houseEtag}
        />
      )}
      {model && error && (
        <p className="banner warn" role="status">
          Couldn’t refresh{loadedAt ? `; showing data from ${loadedAt.toLocaleTimeString()}` : ''}.{' '}
          <button type="button" className="link" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
    </>
  );
}

function Main() {
  const state = useData((s) => s.state);
  const model = useData((s) => s.model);
  const error = useData((s) => s.error);
  const load = useData((s) => s.load);
  const view = useUi((s) => s.view);
  const floorId = useUi((s) => s.floorId);

  if (!model) {
    return state === 'error' ? (
      <section className="stage state" role="alert">
        <h2>Couldn’t load the house</h2>
        <p className="muted">{error}</p>
        <button type="button" className="btn primary" onClick={() => void load()}>
          Try again
        </button>
      </section>
    ) : (
      <section className="stage state" aria-busy="true">
        <p role="status">Loading the house…</p>
      </section>
    );
  }

  if (view === 'list') return <ListView />;
  const floor = (floorId && model.floorById.get(floorId)) || model.floors[0];
  if (!floor) {
    return (
      <section className="stage state">
        <h2>No floor plan yet</h2>
        <p className="muted">
          There is no valid <code>house.json</code> in the data folder. Items are still listed in
          the List view.
        </p>
      </section>
    );
  }
  return <PlanView floor={floor} />;
}

export function App() {
  useApplyTheme();
  const model = useData((s) => s.model);
  const selection = useUi((s) => s.selection);
  const setFloor = useUi((s) => s.setFloor);

  // Opening an item (deep link, search, list) shows the floor it is on.
  useEffect(() => {
    if (selection?.kind !== 'item' || !model) return;
    const floorId = model.items.get(selection.id)?.location?.floorId;
    if (floorId && model.floorById.has(floorId)) setFloor(floorId);
  }, [selection, model, setFloor]);

  return (
    <div className={`app${selection ? ' has-panel' : ''}`}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <div className="brand">
          <b>Housebook</b>
          {model && <span>{model.snapshot.timezone}</span>}
        </div>
        <ViewToggle />
        <SearchBox />
        <ProblemsIndicator count={model?.snapshot.problemCount ?? 0} />
        <ThemeToggle />
      </header>
      <main id="main" className="main">
        <Banners />
        <Main />
      </main>
      <DetailsPanel />
    </div>
  );
}
