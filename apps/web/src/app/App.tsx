import { useEffect, useRef, useState } from 'react';
import { DetailsPanel } from '../features/details/DetailsPanel';
import {
  EditToggle,
  EditorNotices,
  LazyEditorPanels,
  NoFloorPlan,
  useEditorShortcuts,
} from '../features/editor';
import { AttentionView } from '../features/attention/AttentionView';
import { attentionCount } from '../features/attention/entries';
import { ProblemsButton } from '../features/problems/ProblemsButton';
import { ListView } from '../features/list/ListView';
import { PlanView } from '../features/plan2d/PlanView';
import { SearchBox } from '../features/search/SearchBox';
import { readOnlyNotice } from '../components/houseNotice';
import { useData } from '../store/data';
import { useEditor } from '../store/editor';
import { useHouseProblems } from '../store/problems';
import { type PlanStyle, type Selection, type View, useUi } from '../store/ui';
import { choose3d, useShows3d } from './scene3d';
import { Scene3dSlot } from './Scene3dSlot';
import { SyncStatus } from './SyncStatus';
import { NEXT_THEME, useApplyTheme } from './theme';
import { webglAvailable } from './webgl';

function ViewToggle() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const snapshot = useData((s) => s.model?.snapshot);
  const due = snapshot ? attentionCount(snapshot) : 0;
  const options: [View, string][] = [
    ['plan', 'Plan'],
    ['list', 'List'],
    ['attention', 'Attention'],
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
          {v === 'attention' && due > 0 && (
            // Part of the name ("Attention 5"), as seen: the name must contain the visible text.
            <span className="count">{due}</span>
          )}
        </button>
      ))}
    </div>
  );
}

const NO_WEBGL =
  '3D needs WebGL, which this browser has turned off or doesn’t support. The 2D plan and the list show the same house.';

function PlanStyleToggle({ onUnsupported }: { onUnsupported: () => void }) {
  const view = useUi((s) => s.view);
  const setPlanStyle = useUi((s) => s.setPlanStyle);
  const shows3d = useShows3d();
  const supported = webglAvailable();
  const current: PlanStyle = shows3d ? '3d' : '2d';
  return (
    <div className="seg" role="group" aria-label="Plan style">
      <button
        type="button"
        className={view === 'plan' && current === '2d' ? 'on' : undefined}
        aria-pressed={view === 'plan' && current === '2d'}
        onClick={() => setPlanStyle('2d')}
      >
        2D
      </button>
      <button
        type="button"
        className={view === 'plan' && current === '3d' ? 'on' : undefined}
        aria-pressed={view === 'plan' && current === '3d'}
        aria-disabled={supported ? undefined : true}
        aria-describedby={supported ? undefined : 'no-webgl'}
        title={supported ? '3D view' : NO_WEBGL}
        onClick={() => {
          // Touch users never see `title`: a tap on the disabled button says why in the page.
          if (supported) choose3d();
          else onUnsupported();
        }}
      >
        3D
      </button>
      {!supported && (
        <span id="no-webgl" className="sr-only">
          {NO_WEBGL}
        </span>
      )}
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

function Scene3dBanner() {
  const view = useUi((s) => s.view);
  const style = useUi((s) => s.planStyle);
  const issue = useUi((s) => s.scene3dIssue);
  const takeFocus = useUi((s) => s.scene3dFocus);
  const clearFocus = useUi((s) => s.clearScene3dFocus);
  const retry = useRef<HTMLButtonElement>(null);
  const shown = view === 'plan' && style === '3d' && !!issue;
  // The 3D view had focus and is gone: keep the keyboard user's place on the way back to 3D.
  useEffect(() => {
    if (!shown || !takeFocus) return;
    retry.current?.focus();
    clearFocus();
  }, [shown, takeFocus, clearFocus]);
  if (!shown) return null;
  return (
    <p className="banner warn" role="status" data-reason={issue}>
      {issue === 'context_lost'
        ? 'The 3D view stopped because the browser dropped its graphics context. Showing the 2D plan.'
        : 'Couldn’t load the 3D view. Showing the 2D plan.'}{' '}
      <button ref={retry} type="button" className="link" onClick={choose3d}>
        {issue === 'context_lost' ? 'Reload 3D' : 'Try 3D again'}
      </button>
    </p>
  );
}

function Banners({ why3d }: { why3d: boolean }) {
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
      <Scene3dBanner />
      {why3d && (
        <p className="banner" role="status" data-reason="no_webgl">
          {NO_WEBGL}
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
  const shows3d = useShows3d();

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
  if (view === 'attention') return <AttentionView />;
  const floor = (floorId && model.floorById.get(floorId)) || model.floors[0];
  if (!floor) return <NoFloorPlan />;
  return shows3d ? <Scene3dSlot floor={floor} /> : <PlanView floor={floor} />;
}

export function App() {
  useApplyTheme();
  const model = useData((s) => s.model);
  const selection = useUi((s) => s.selection);
  const setFloor = useUi((s) => s.setFloor);
  const editing = useEditor((s) => s.mode === 'edit');
  const [why3d, setWhy3d] = useState(false);
  useEditorShortcuts();

  // Opening an item (deep link, search, list) shows the floor it is on: once per selection,
  // when the model has it. A background refresh must not pull someone browsing another floor
  // back to the selected item's floor.
  const floorShownFor = useRef<Selection>(null);
  useEffect(() => {
    if (selection?.kind !== 'item' || !model || floorShownFor.current === selection) return;
    const floorId = model.items.get(selection.id)?.location?.floorId;
    if (!floorId || !model.floorById.has(floorId)) return;
    floorShownFor.current = selection;
    setFloor(floorId);
  }, [selection, model, setFloor]);

  return (
    <div className={`app${selection ? ' has-panel' : ''}${editing ? ' editing' : ''}`}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <div className="brand">
          <b>Housebook</b>
          {model && <span>{model.snapshot.timezone}</span>}
        </div>
        <ViewToggle />
        <PlanStyleToggle onUnsupported={() => setWhy3d(true)} />
        <SearchBox />
        <EditToggle />
        <ProblemsButton />
        <SyncStatus />
        <ThemeToggle />
      </header>
      <LazyEditorPanels />
      <main id="main" className="main">
        <Banners why3d={why3d} />
        <Main />
      </main>
      <DetailsPanel />
      <EditorNotices />
    </div>
  );
}
