import type { Item, Snapshot } from '../api/types';
import { buildModel } from '../store/model';
import { useData } from '../store/data';
import { useUi } from '../store/ui';

const noStatus = { level: null, check: null, warranty: null };

export function makeItem(over: Partial<Item> & Pick<Item, 'id' | 'name'>): Item {
  return {
    path: `House/Kitchen/${over.name}.md`,
    etag: 'x',
    attachmentsEtag: '0000000000000000',
    type: 'other',
    typeKnown: true,
    critical: false,
    fields: {},
    frontmatter: {},
    status: noStatus,
    location: null,
    errorCodes: [],
    attachments: [],
    stale: false,
    parseError: null,
    obsidianUrl: null,
    body: '',
    ...over,
  };
}

export const dishwasher = makeItem({
  id: 'it_dish',
  name: 'Dishwasher',
  type: 'dishwasher',
  fields: {
    brand: 'Bosch',
    model: 'SMS4HVI33E',
    serial: 'FD 0412 00123',
    next_check: '2026-11-01',
    warranty_until: '2026-12-01',
    manual: 'javascript:alert(1)',
    support: 'https://bosch.example/',
  },
  status: {
    level: 'overdue',
    check: { state: 'overdue', date: '2026-11-01', days: -3, derived: false },
    warranty: { state: 'ending', date: '2026-12-01', days: 27 },
  },
  location: { floorId: 'fl_0', roomId: 'rm_kit', x: 1, y: 0, rotation: 0 },
  errorCodes: ['E15'],
  body: '## Quick help\n- **E15**: water in the base. See [[Fridge]] and [[Nowhere]].\n- [bad](javascript:alert(1)) and [ok](https://example.com)\n\n<script>alert(1)</script><b>raw</b>',
});

export const fridge = makeItem({
  id: 'it_fridge',
  name: 'Fridge',
  type: 'fridge',
  path: 'House/Kitchen/Fridge.md',
  location: { floorId: 'fl_0', roomId: 'rm_kit', x: 0, y: 0, rotation: 0 },
  obsidianUrl: 'obsidian://open?vault=v&file=House%2FKitchen%2FFridge.md',
});

export const heater = makeItem({
  id: 'it_heat',
  name: 'Water heater',
  type: 'heater',
  location: { floorId: 'fl_0', roomId: 'rm_bat', x: 2, y: 0, rotation: 0 },
  body: 'Ηλεκτρικός θερμοσίφωνας 80 λίτρων.',
});

export const snapshot: Snapshot = {
  today: '2026-11-04',
  timezone: 'UTC',
  houseEtag: 'h',
  houseReadOnly: false,
  houseSchemaVersion: 1,
  problemCount: 0,
  itemsVersion: 'v',
  house: {
    schemaVersion: 2,
    grid: { tileSize: 1, width: 4, depth: 2 },
    rooms: [
      { id: 'rm_kit', name: 'Kitchen', color: '#E3A94B' },
      { id: 'rm_bat', name: 'Bathroom', color: '#5FC1B5' },
    ],
    floors: [
      {
        id: 'fl_0',
        name: 'Ground',
        level: 0,
        cells: { '0,0': 'rm_kit', '1,0': 'rm_kit', '2,0': 'rm_bat' },
      },
    ],
    placements: [],
    openings: [],
  },
  items: [dishwasher, fridge, heater],
};

/** Put the fixture snapshot in the store as if it had just loaded, with "today" frozen. */
export function seedStore(snap: Snapshot = snapshot) {
  useData.setState({
    state: 'ready',
    model: buildModel(snap),
    etag: 'e',
    error: null,
    loadedAt: new Date(),
    problemCount: snap.problemCount,
    me: null,
  });
  useUi.setState({ selection: null, query: '', floorId: null, view: 'plan' });
}
