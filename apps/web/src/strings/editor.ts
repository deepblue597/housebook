/**
 * UI text of the layout editor (milestone 5), in one place (DESIGN 15.16 "UI language"). Plain
 * English for now; functions take the values they interpolate so a translation can reorder them.
 */
import type { ConflictCode, RepairFix } from '../commands';
import type { LayoutIssue } from '../domain/layout';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const EDITOR = {
  // mode
  editToggle: 'Edit',
  editToggleTitle: 'Edit the layout: rooms, items, house size',
  editOnTitle: 'Leave edit mode',
  editUnavailableReadOnly: 'The layout is read-only, so it can’t be edited here.',
  railLabel: 'Editor tools',
  sidebarLabel: 'Editor',

  // tools
  tools: {
    select: { label: 'Select and move', key: 'V' },
    paint: { label: 'Paint room', key: 'B' },
    erase: { label: 'Erase tiles', key: 'E' },
    place: { label: 'Place item', key: 'P' },
  },
  toolHint: {
    select:
      'Click an item to select it, again to cycle through stacked items. Drag an item to move it. Drag empty space to pan.',
    paint: (room: string) => `Click or drag a rectangle to paint tiles as ${room}.`,
    paintNoRoom: 'Add a room first, then paint its tiles.',
    erase: 'Click or drag a rectangle to clear tiles.',
    placeType: (type: string) => `Click a tile to add a new ${type}.`,
    placeItem: (name: string) => `Click a tile to place ${name}.`,
    cancel: 'Esc cancels.',
  },
  undo: 'Undo',
  redo: 'Redo',
  undoTitle: (label: string | null) => (label ? `Undo ${label} (Ctrl+Z)` : 'Nothing to undo'),
  redoTitle: (label: string | null) => (label ? `Redo ${label} (Ctrl+Shift+Z)` : 'Nothing to redo'),
  resize: 'Resize house…',

  // save state
  save: {
    saved: 'All changes saved',
    pending: 'Unsaved changes',
    saving: 'Saving…',
    error: 'Couldn’t save',
    retry: 'Retry',
    discard: 'Discard unsaved changes',
    discardConfirm:
      'Discard every layout change that hasn’t been saved yet? The layout goes back to the server’s version.',
  },
  saveFailed: (why: string) => `Couldn’t save the layout: ${why}`,
  saveRejected: (why: string) =>
    `The server refused the layout: ${why}. This shouldn’t happen (the editor sent something it shouldn’t have; please report it). Discard the unsaved changes, or try again.`,
  saveReadOnly: 'The layout became read-only on the server; your changes can’t be saved.',
  leaveWarning: 'Layout changes are still being saved.',

  // replay and conflicts
  dropped: (label: string, why: string) => `Your edit “${label}” was dropped: ${why}.`,
  undoFailed: (label: string, why: string) => `Couldn’t undo “${label}”: ${why}.`,
  redoFailed: (label: string, why: string) => `Couldn’t redo “${label}”: ${why}.`,
  editFailed: (why: string) => `That edit isn’t possible: ${why}.`,
  conflict: (code: ConflictCode | null, subject: string | null): string => {
    const s = subject ? `“${subject}”` : null;
    switch (code) {
      case 'floor_missing':
        return 'its floor was deleted elsewhere';
      case 'room_missing':
        return s ? `the room ${s} no longer exists` : 'the room no longer exists';
      case 'room_exists':
        return 'a room with the same id already exists';
      case 'room_in_use':
        return s ? `the room ${s} still has tiles` : 'the room still has tiles';
      case 'outside_grid':
        return 'it is outside the house';
      case 'not_placed':
        return `${s ?? 'the item'} is no longer on the plan`;
      case 'already_placed':
        return `${s ?? 'the item'} was placed elsewhere meanwhile`;
      case 'grid_changed':
        return 'the house was resized elsewhere';
      case 'size_invalid':
        return 'the house must be 1 to 512 tiles on each side';
      case 'more_lost':
        return 'it would now remove more than you confirmed';
      case null:
        return 'an earlier edit it depends on was dropped';
    }
  },
  undoRepairSaved: (label: string) =>
    `“${label}” is already saved, so it can’t be undone: undoing it would put a fixed problem back into house.json, which the server doesn’t accept.`,
  redoRepairSaved: (label: string) =>
    `Can’t redo “${label}”: it would put a problem back into house.json, which the server doesn’t accept.`,
  historyCleared:
    'The house was resized elsewhere, so the undo history no longer fits it and was cleared.',
  dismiss: 'Dismiss',
  noticesLabel: 'Editor messages',

  // command labels (history, messages)
  label: {
    paint: (n: number, room: string) => `paint ${plural(n, 'tile', 'tiles')} ${room}`,
    erase: (n: number) => `erase ${plural(n, 'tile', 'tiles')}`,
    place: (name: string) => `place ${name}`,
    move: (name: string) => `move ${name}`,
    rotate: (name: string) => `rotate ${name}`,
    unplace: (name: string) => `remove ${name} from the plan`,
    relink: (id: string, name: string) => `relink ${id} to ${name}`,
    removeGhost: (id: string) => `remove the placement of ${id}`,
    roomAdd: (name: string) => `add room ${name}`,
    roomRename: (from: string, to: string) => `rename ${from} to ${to}`,
    roomColor: (name: string) => `recolour ${name}`,
    roomRemove: (name: string) => `delete room ${name}`,
    resize: (w: number, d: number) => `resize the house to ${w} × ${d}`,
  },

  // rooms
  rooms: 'Rooms',
  roomAdd: 'Add room',
  roomDefaultName: (n: number) => `Room ${n}`,
  roomName: (name: string) => `Name of ${name}`,
  roomColor: (name: string) => `Colour of ${name}`,
  roomPaint: (name: string) => `Paint with ${name}`,
  roomDelete: (name: string) => `Delete ${name}`,
  roomDeleteDisabled: 'Erase the room’s tiles first',
  roomTiles: (n: number) => plural(n, 'tile', 'tiles'),
  roomNameInvalid: 'A room name needs 1 to 100 characters.',
  noRooms: 'No rooms yet.',

  // catalogue
  catalogue: 'Add item',
  catalogueHint: 'Choose a type, then click a tile.',
  addType: (label: string) => `Add ${label}`,

  // unplaced tray
  unplaced: 'Unplaced',
  unplacedHint:
    'Notes without a place on the plan. Drag one onto the plan, or choose it and click a tile.',
  unplacedEmpty: 'Every item is on the plan.',
  placeThis: (name: string) => `Place ${name}`,

  // new item dialog (D8: the note first, then the placement)
  newItemTitle: (label: string) => `New ${label}`,
  newItemName: 'Name',
  newItemWhere: (room: string | null, floor: string) =>
    room ? `In ${room} on ${floor}.` : `On ${floor}, outside any room.`,
  newItemNote: 'A note is created in the notes folder; you can fill it in later.',
  newItemCreate: 'Add',
  newItemCancel: 'Cancel',
  newItemCreating: 'Adding…',
  newItemFailed: (why: string) => `Couldn’t create the note: ${why}`,
  newItemNameInvalid: 'Give it a name.',

  // selected item / ghost actions (details panel)
  layoutActions: 'On the plan',
  rotate: 'Rotate 90°',
  rotateTitle: 'Rotate 90° clockwise (R)',
  unplace: 'Remove from plan',
  unplaceTitle: 'Move it to the Unplaced tray; the note stays (Delete)',
  rotateNoRoom: 'It doesn’t fit the house when rotated.',
  ghostEditHint: 'Switch to Edit mode to relink this placement to a note or remove it.',
  ghostRelinkLabel: 'Relink to an unplaced note',
  ghostRelinkChoose: 'Choose a note…',
  ghostRelink: 'Relink',
  ghostRemove: 'Remove placement',
  ghostNoCandidates: 'No unplaced notes to relink to.',

  // resize dialog (D17b)
  resizeTitle: 'Resize house',
  resizeIntro: (w: number, d: number, tile: number) =>
    `The house is ${w} × ${d} tiles (tile ${tile} m). Add tiles on a side with a positive number, remove them with a negative one.`,
  sides: { n: 'North', e: 'East', s: 'South', w: 'West' },
  sideLabel: (side: string) => `${side} side: tiles to add (negative removes)`,
  resizeNew: (w: number, d: number) => `New size: ${w} × ${d} tiles.`,
  resizeInvalid: 'Each side must end up between 1 and 512 tiles.',
  resizeNoChange: 'Nothing to change yet.',
  resizeShift: 'Adding on the north or west side shifts everything, so nothing moves on the plan.',
  resizeLoss: 'This removes:',
  resizeLossCells: (n: number, rooms: string) =>
    `${plural(n, 'painted tile', 'painted tiles')} (${rooms})`,
  resizeLossItems: (names: string) => `from the plan, to the Unplaced tray: ${names}`,
  resizeLossOpenings: (n: number) => plural(n, 'door or window', 'doors and windows'),
  resizeConfirm: 'Remove these',
  resizeApply: 'Resize',
  resizeApplyLoss: 'Resize and remove',
  resizeCancel: 'Cancel',
  tileSizeFixed: 'The tile size can’t be changed here.',

  // repairs of problems in the layout (D30)
  repair: {
    title: 'Problems in the layout',
    intro:
      'house.json has problems the editor didn’t cause. Each fix is one edit you can undo; nothing is changed until you choose one.',
    recoveredRoom: (n: number) => (n === 1 ? 'Recovered room' : `Recovered room ${n}`),
    describe: (issue: LayoutIssue, name: (itemId: string) => string): string => {
      switch (issue.kind) {
        case 'unknown_room':
          return `${plural(issue.cells.length, 'tile points', 'tiles point')} to a room that doesn’t exist (${issue.roomId}).`;
        case 'duplicate_placement':
          return `${name(issue.itemId)} is placed ${issue.count} times; the plan shows the first.`;
        case 'outside_grid': {
          const parts = [
            issue.cells.length ? plural(issue.cells.length, 'tile', 'tiles') : null,
            issue.itemIds.length ? issue.itemIds.map(name).join(', ') : null,
            issue.openings.length
              ? plural(issue.openings.length, 'door or window', 'doors and windows')
              : null,
          ].filter(Boolean);
          return `Outside the house: ${parts.join('; ')}.`;
        }
        case 'unknown_floor': {
          const parts = [
            issue.itemIds.length ? issue.itemIds.map(name).join(', ') : null,
            issue.openings.length
              ? plural(issue.openings.length, 'door or window', 'doors and windows')
              : null,
          ].filter(Boolean);
          return `On a floor that doesn’t exist: ${parts.join('; ')}.`;
        }
      }
    },
    button: (issue: LayoutIssue, fix: RepairFix): string => {
      switch (fix) {
        case 'recreate_room':
          return 'Recreate room';
        case 'erase_tiles':
          return 'Erase tiles';
        case 'keep_first':
          return 'Keep the first';
        case 'grow':
          return issue.kind === 'outside_grid' && issue.fit
            ? `Grow to ${issue.fit.width} × ${issue.fit.depth}`
            : 'Grow';
        case 'remove_outside':
          return 'Remove what’s outside';
        case 'remove_unknown_floor':
          return 'Remove them';
      }
    },
    label: (issue: LayoutIssue, fix: RepairFix, name: (itemId: string) => string): string => {
      switch (fix) {
        case 'recreate_room':
          return `recreate room ${issue.kind === 'unknown_room' ? issue.roomId : ''}`.trim();
        case 'erase_tiles':
          return issue.kind === 'unknown_room'
            ? `erase ${plural(issue.cells.length, 'tile', 'tiles')} of the missing room ${issue.roomId}`
            : 'erase tiles';
        case 'keep_first':
          return `keep one placement of ${issue.kind === 'duplicate_placement' ? name(issue.itemId) : ''}`.trim();
        case 'grow':
          return issue.kind === 'outside_grid' && issue.fit
            ? `grow the house to ${issue.fit.width} × ${issue.fit.depth}`
            : 'grow the house';
        case 'remove_outside':
          return 'remove what’s outside the house';
        case 'remove_unknown_floor':
          return 'remove what’s on missing floors';
      }
    },
  },

  // shortcuts
  shortcuts:
    'Shortcuts: V select, B paint, E erase, R rotate, Delete remove from plan, Ctrl+Z undo, Ctrl+Shift+Z redo, Esc cancel.',
} as const;
