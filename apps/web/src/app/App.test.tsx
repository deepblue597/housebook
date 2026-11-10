import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUi } from '../store/ui';
import type { Snapshot } from '../api/types';
import { useData } from '../store/data';
import { buildModel } from '../store/model';
import { dishwasher, fridge, heater, seedStore, snapshot } from '../test/fixtures';
import { App } from './App';
import { loadScene3d } from './scene3d';
import type * as SceneLoaderModule from './scene3d';

type SceneLoader = typeof SceneLoaderModule;
import { resetWebglProbe } from './webgl';

// The real 3D chunk needs WebGL; here a stand-in proves what mounts where.
vi.mock('./scene3d', async (importOriginal) => {
  const mod = {
    default: ({ floor }: { floor: { floor: { name: string } } }) => (
      <section aria-label="3D view">3D of {floor.floor.name}</section>
    ),
  };
  // Marked as settled the way React's use() tracks thenables, so it renders without suspending.
  const stub = Object.assign(Promise.resolve(mod), { status: 'fulfilled', value: mod });
  return { ...(await importOriginal<SceneLoader>()), loadScene3d: () => stub };
});

const webgl = (ok: boolean) =>
  vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue((ok ? { getExtension: () => null } : null) as never);

/** Let the (mocked) lazy import settle inside act, as React's test environment needs. */
const settle = () => act(async () => void (await loadScene3d()));

const style = () => screen.getByRole('group', { name: 'Plan style' });

describe('2D/3D toggle', () => {
  beforeEach(() => {
    resetWebglProbe();
    seedStore();
    useUi.setState({ planStyle: '2d', scene3dIssue: null });
  });
  afterEach(() => localStorage.clear());

  it('2D is the default; 3D swaps the plan for the lazy 3D view', async () => {
    webgl(true);
    const user = userEvent.setup();
    render(<App />);
    const [two, three] = [
      screen.getByRole('button', { name: '2D' }),
      screen.getByRole('button', { name: '3D' }),
    ];
    expect(two).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: /Plan of Ground/ })).toBeInTheDocument();
    await user.click(three);
    await settle();
    expect(screen.getByRole('region', { name: '3D view' })).toHaveTextContent('3D of Ground');
    expect(three).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('region', { name: /Plan of Ground/ })).toBeNull();
    // From the list, choosing a plan style shows the plan.
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(three).toHaveAttribute('aria-pressed', 'false');
    await user.click(two);
    expect(useUi.getState().view).toBe('plan');
    expect(screen.getByRole('region', { name: /Plan of Ground/ })).toBeInTheDocument();
  });

  it('without WebGL, 3D is disabled with an explanation and 2D stays', async () => {
    webgl(false);
    useUi.setState({ planStyle: '3d' }); // remembered from another device or browser
    const user = userEvent.setup();
    render(<App />);
    const three = screen.getByRole('button', { name: '3D' });
    expect(three).toHaveAttribute('aria-disabled', 'true');
    expect(three).toHaveAccessibleDescription(/needs WebGL/);
    expect(screen.getByRole('region', { name: /Plan of Ground/ })).toBeInTheDocument();
    await user.click(three);
    expect(screen.queryByRole('region', { name: '3D view' })).toBeNull();
    expect(within(style()).getByRole('button', { name: '2D' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('a lost WebGL context falls back to 2D with a "Reload 3D" button', async () => {
    webgl(true);
    useUi.setState({ planStyle: '3d' });
    const user = userEvent.setup();
    render(<App />);
    await settle();
    expect(screen.getByRole('region', { name: '3D view' })).toBeInTheDocument();
    act(() => useUi.getState().setScene3dIssue('context_lost'));
    expect(screen.getByRole('region', { name: /Plan of Ground/ })).toBeInTheDocument();
    expect(screen.getByText(/dropped its graphics context/)).toHaveAttribute(
      'data-reason',
      'context_lost',
    );
    await user.click(screen.getByRole('button', { name: 'Reload 3D' }));
    await settle();
    expect(screen.getByRole('region', { name: '3D view' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload 3D' })).toBeNull();
  });
});

describe('3D fallbacks keep the user oriented', () => {
  beforeEach(() => {
    resetWebglProbe();
    seedStore();
    useUi.setState({ planStyle: '2d', scene3dIssue: null, scene3dFocus: false });
  });
  afterEach(() => localStorage.clear());

  it('M2-02: a context loss while the 3D view had focus moves focus to "Reload 3D"', async () => {
    webgl(true);
    useUi.setState({ planStyle: '3d' });
    render(<App />);
    await settle();
    act(() => useUi.getState().setScene3dIssue('context_lost', true));
    expect(screen.getByRole('button', { name: 'Reload 3D' })).toHaveFocus();
    expect(useUi.getState().scene3dFocus).toBe(false);
  });

  it('a context loss without focus in the 3D view leaves focus alone', async () => {
    webgl(true);
    useUi.setState({ planStyle: '3d' });
    render(<App />);
    await settle();
    const search = screen.getByRole('combobox');
    search.focus();
    act(() => useUi.getState().setScene3dIssue('context_lost'));
    expect(search).toHaveFocus();
  });

  it('without WebGL, tapping 3D says why in visible text (touch users never see title)', async () => {
    webgl(false);
    const user = userEvent.setup();
    render(<App />);
    expect(screen.queryByText(/3D needs WebGL/, { selector: '.banner' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '3D' }));
    const note = screen.getByText(/3D needs WebGL/, { selector: '.banner' });
    expect(note).toBeVisible();
    expect(note).toHaveAttribute('role', 'status');
    expect(screen.getByRole('region', { name: /Plan of Ground/ })).toBeInTheDocument();
  });
});

describe('the selected item’s floor', () => {
  const twoFloors = (): Snapshot => ({
    ...snapshot,
    house: {
      ...snapshot.house!,
      floors: [
        ...snapshot.house!.floors,
        { id: 'fl_1', name: 'Upstairs', level: 1, cells: { '0,0': 'rm_bat' } },
      ],
    },
  });
  beforeEach(() => {
    resetWebglProbe();
    seedStore(twoFloors());
    useUi.setState({ planStyle: '2d', scene3dIssue: null });
  });

  it('is shown once per selection; a background refresh keeps the floor being browsed', () => {
    render(<App />);
    act(() => useUi.getState().select({ kind: 'item', id: dishwasher.id }));
    expect(useUi.getState().floorId).toBe('fl_0');
    // Browse another floor with the item still open…
    act(() => useUi.getState().setFloor('fl_1'));
    // …then the snapshot is refreshed in the background (focus, rescan).
    act(() => useData.setState({ model: buildModel(twoFloors()), loadedAt: new Date() }));
    expect(useUi.getState().floorId).toBe('fl_1');
    // Choosing an item again does show its floor.
    act(() => useUi.getState().select({ kind: 'item', id: dishwasher.id }));
    expect(useUi.getState().floorId).toBe('fl_0');
  });

  it('a deep link shows the item’s floor once the house has loaded', () => {
    useData.setState({ model: null, state: 'loading' });
    useUi.setState({ selection: { kind: 'item', id: dishwasher.id }, floorId: 'fl_1' });
    render(<App />);
    expect(useUi.getState().floorId).toBe('fl_1');
    act(() => useData.setState({ model: buildModel(twoFloors()), state: 'ready' }));
    expect(useUi.getState().floorId).toBe('fl_0');
  });
});

describe('2D plan footprints (data contract §2.2, same rule as 3D)', () => {
  beforeEach(() => {
    resetWebglProbe();
    useUi.setState({ planStyle: '2d', scene3dIssue: null });
  });

  it('a multi-tile item covers its whole rotated rectangle, badge in the middle', () => {
    // Fridge at (0,0) with a [2,1] footprint turned 90°: occupies (0,0) and (0,1).
    const snap: Snapshot = {
      ...snapshot,
      house: {
        ...snapshot.house!,
        floors: [
          {
            ...snapshot.house!.floors[0]!,
            cells: { ...snapshot.house!.floors[0]!.cells, '0,1': 'rm_kit' },
          },
        ],
        placements: [
          { itemId: fridge.id, floorId: 'fl_0', x: 0, y: 0, rotation: 90, footprint: [2, 1] },
        ],
      },
      items: [dishwasher, { ...fridge, location: { ...fridge.location!, rotation: 90 } }, heater],
    };
    seedStore(snap);
    const { container } = render(<App />);
    const badge = container.querySelector(`[data-item-id="${fridge.id}"]`)!;
    // S = 40 plan units per tile: centre of tiles (0,0)–(0,1) is (20, 40).
    expect(badge.getAttribute('transform')).toBe('translate(20,40)');
    const fp = badge.querySelector('.hit.fp')!;
    expect([fp.getAttribute('width'), fp.getAttribute('height')]).toEqual(['40', '80']);
    // A 1×1 item keeps its plain tile hit area.
    const dish = container.querySelector(`[data-item-id="${dishwasher.id}"]`)!;
    expect(dish.querySelector('.hit.fp')).toBeNull();
    expect(dish.getAttribute('transform')).toBe('translate(60,20)');
  });
});

describe('Attention view (D38)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${snapshot.today}T12:00:00Z`));
    seedStore();
  });
  afterEach(() => vi.useRealTimers());

  it('the view switch counts the items that need attention and opens the list', async () => {
    const user = userEvent.setup();
    render(<App />);
    const views = screen.getByRole('group', { name: 'View' });
    const button = within(views).getByRole('button', { name: /^Attention\s*1$/ });
    await user.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'What needs attention' })).toBeInTheDocument();
    expect(localStorage.getItem('housebook.view')).toBe('attention');
  });
});
