/**
 * UI text of the layout editor (milestone 5), in one place (DESIGN 15.16 "UI language"). Plain
 * English for now; functions take the values they interpolate so a translation can reorder them.
 */
import type { ConflictCode, RepairFix } from '../commands';
import type { LayoutIssue } from '../domain/layout';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "1 door", "2 windows and 1 open wall": openings counted by kind (D51). */
const openingsByKind = (openings: readonly { kind: string }[]) => {
  const count = (k: string) => openings.filter((o) => o.kind === k).length;
  const parts = [
    ['door', 'doors'],
    ['window', 'windows'],
    ['open', 'open walls'],
  ].flatMap(([kind, many]) => {
    const n = count(kind!);
    return n ? [plural(n, kind === 'open' ? 'open wall' : kind!, many!)] : [];
  });
  return listOf(parts);
};
/** "A", "A and B", "A, B and C". */
const listOf = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

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
    door: { label: 'Door', key: 'D' },
    window: { label: 'Window', key: 'W' },
    open: { label: 'Open wall', key: 'O' },
  },
  toolHint: {
    select:
      'Click an item to select it, again to cycle through stacked items. Drag an item to move it. Drag empty space to pan.',
    paint: (room: string) => `Click or drag a rectangle to paint tiles as ${room}.`,
    paintNoRoom: 'Add a room first, then paint its tiles.',
    erase: 'Click or drag a rectangle to clear tiles.',
    placeType: (type: string) => `Click a tile to add a new ${type}.`,
    placeItem: (name: string) => `Click a tile to place ${name}.`,
    door: 'Click a wall to add a door there; click a door to remove it, a window to make it a door.',
    window:
      'Click a wall to add a window there; click a window to remove it, a door to make it a window.',
    open: 'Drag along a wall between two rooms to open it (open plan); drag along an open wall to close it.',
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
      case 'floor_exists':
        return 'a floor with the same id already exists';
      case 'last_floor':
        return 'a house needs at least one floor';
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
      case 'note_deleted':
        return 'its note was deleted';
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
    roomFinish: (name: string) => `change the finish of ${name}`,
    finishCopy: (name: string, n: number) =>
      `copy the finish of ${name} to ${plural(n, 'room', 'rooms')}`,
    exteriorWalls: 'change the outside walls',
    roomRemove: (name: string) => `delete room ${name}`,
    openingAdd: (kind: 'door' | 'window') => `add a ${kind}`,
    openingRemove: (kind: 'door' | 'window') => `remove a ${kind}`,
    openingSwap: (from: 'door' | 'window' | 'open', to: 'door' | 'window') =>
      from === 'open' ? `put a ${to} in an open wall` : `make a ${from} a ${to}`,
    openWallOpen: (tiles: number) => `open ${plural(tiles, 'tile', 'tiles')} of wall`,
    openWallClose: (tiles: number) => `close ${plural(tiles, 'tile', 'tiles')} of open wall`,
    floorAdd: (name: string) => `add floor ${name}`,
    floorRename: (from: string, to: string) => `rename ${from} to ${to}`,
    floorMove: (name: string, dir: 'up' | 'down') => `move ${name} ${dir}`,
    floorRemove: (name: string) => `delete floor ${name}`,
    resize: (w: number, d: number) => `resize the house to ${w} × ${d}`,
  },

  openingNotWall: 'Doors and windows go on walls: between two rooms, or a room and the outside.',
  openWallNotBetweenRooms:
    'Only walls between two rooms can be opened; the outside of the house keeps its walls.',

  // floors (D35)
  floors: 'Floors',
  floorAddAbove: 'Floor above',
  floorAddBelow: 'Floor below',
  floorDefaultName: (level: number) =>
    level === 0
      ? 'Ground floor'
      : level > 0
        ? `Floor ${level}`
        : level === -1
          ? 'Basement'
          : `Basement ${-level}`,
  floorName: (name: string) => `Name of ${name}`,
  floorShow: (name: string) => `Show ${name}`,
  floorUp: (name: string) => `Move ${name} up`,
  floorDown: (name: string) => `Move ${name} down`,
  floorDelete: (name: string) => `Delete ${name}`,
  floorDeleteLast: 'A house needs at least one floor',
  floorNameInvalid: 'A floor name needs 1 to 100 characters.',
  floorLevelLimit: 'Floors go from 20 below ground to 200 above.',
  floorContents: (tiles: number, items: number) =>
    [plural(tiles, 'tile', 'tiles'), items ? plural(items, 'item', 'items') : null]
      .filter(Boolean)
      .join(' · '),
  floorDeleteTitle: (name: string) => `Delete “${name}”?`,
  floorDeleteLoses: 'This floor goes, with everything on it:',
  floorLossTiles: (n: number, rooms: { name: string; n: number }[]) =>
    rooms.length === 1
      ? `${plural(n, 'tile', 'tiles')} of ${rooms[0]!.name}`
      : `${plural(n, 'tile', 'tiles')}: ${rooms.map((r) => `${r.name} ${r.n}`).join(', ')}`,
  floorLossItems: (names: string) => `from the plan, to the Unplaced tray (notes stay): ${names}`,
  floorLossOpenings: (openings: readonly { kind: string }[]) => openingsByKind(openings),
  floorDeleteEmpty: 'The floor is empty.',
  floorDeleteUndo: 'Undo (Ctrl+Z) brings it all back.',
  floorDeleteConfirm: 'Delete floor',

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
  roomTilesOn: (n: number, floors: readonly string[]) =>
    floors.length
      ? `${plural(n, 'tile', 'tiles')} · ${floors.join(', ')}`
      : plural(n, 'tile', 'tiles'),
  // #14: rooms are shared by every floor they are on.
  sharedRoomPaint: (room: string, floors: readonly string[]) =>
    `${room} is also on ${listOf(floors)}: these tiles are part of the same room. For a separate room here, undo (Ctrl+Z) and use “+ Add room”.`,
  sharedRoomRenamed: (to: string, floors: readonly string[]) =>
    `Renamed to ${to} on ${listOf(floors)}: a room is the same on every floor it is on. Undo (Ctrl+Z) if you meant a new room.`,
  sharedRoomRecoloured: (room: string, floors: readonly string[]) =>
    `${room} changed colour on ${listOf(floors)}: a room is the same on every floor it is on.`,
  finishShared: (floors: readonly string[]) =>
    `This room is on ${listOf(floors)}: its finish changes on all of them.`,
  roomNameInvalid: 'A room name needs 1 to 100 characters.',
  noRooms: 'No rooms yet.',

  // finishes (D41)
  finish: (name: string) => `Finish of ${name}`,
  finishFloor: 'Floor',
  finishWalls: 'Walls',
  finishNone: 'None',
  finishNoneFloorHint: 'shown in the room’s plan colour',
  finishPaint: 'Paint',
  finishOtherColour: 'Other colour',
  finishWallpaper: 'Wallpaper',
  finishCopy: 'Copy to other rooms',
  finishCopyButton: (n: number) => `Copy to ${plural(n, 'room', 'rooms')}`,
  finishCopyHint: 'Gives the chosen rooms this room’s floor and walls, as one undo step.',
  finishOutside: 'Outside walls (whole house)',
  finishOutsideReset: 'Default',
  finishSeeIt: 'Finishes show in the Home look.',
  finishShowHome: 'Turn on Home look',
  finishUnknown: (key: string) => `“${key}” isn’t a finish this version knows; pick another.`,
  finishSharedFloors: 'A room has the same finish on every floor it is on.',

  // your own textures (D43)
  ownTextures: 'Your own',
  ownAdd: (kind: 'floor' | 'wallpaper') =>
    kind === 'floor' ? 'Add your own floor…' : 'Add your own wallpaper…',
  ownAddTitle: (kind: 'floor' | 'wallpaper') =>
    kind === 'floor' ? 'Your own floor' : 'Your own wallpaper',
  ownFile: 'Photo or scan (JPEG, PNG, WebP or HEIC)',
  ownName: 'Name',
  ownRepeat: 'The pattern repeats every',
  ownAcross: 'across (cm)',
  ownAlong: (kind: 'floor' | 'wallpaper') => (kind === 'floor' ? 'along (cm)' : 'up (cm)'),
  ownRepeatHint:
    'Measure one repeat: a tile with its grout line, a plank and its neighbours, or the pattern repeat printed on a wallpaper’s label. The image should show exactly that much.',
  ownSave: 'Add and use',
  ownSaving: 'Adding…',
  ownCancel: 'Cancel',
  ownNeedFile: 'Choose an image.',
  ownNeedName: 'Give it a name.',
  ownBadSize: 'Enter sizes between 1 and 2000 cm.',
  ownTooLarge: 'The image is too large (25 MB at most).',
  ownWrongType: 'Only JPEG, PNG, WebP or HEIC images can be textures.',
  ownUnreachable: 'The server couldn’t be reached; try again.',
  ownMissing: 'image missing',
  ownDelete: (label: string) => `Delete ${label}`,
  ownDeleteAsk: (label: string) => `Delete “${label}”? Its image goes to the trash.`,
  ownDeleteYes: 'Delete',
  ownDeleteNo: 'Keep',
  ownInUse: (label: string, rooms: readonly string[]) =>
    `“${label}” is used by ${listOf(rooms)}; choose another finish there first.`,

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
  resizeLossOpenings: (openings: readonly { kind: string }[]) => openingsByKind(openings),
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
            issue.openings.length ? openingsByKind(issue.openings) : null,
          ].filter(Boolean);
          return `Outside the house: ${parts.join('; ')}.`;
        }
        case 'unknown_floor': {
          const parts = [
            issue.itemIds.length ? issue.itemIds.map(name).join(', ') : null,
            issue.openings.length ? openingsByKind(issue.openings) : null,
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
