/** Human-readable titles and explanations for problem kinds (data contract §7). */
import type { Problem, ProblemKind } from '../../api/types';

export const PROBLEM_TEXT: Record<ProblemKind, { title: string; help: string }> = {
  house_missing: {
    title: 'No house layout',
    help: 'There is no house.json in the data folder.',
  },
  house_invalid: {
    title: 'House layout can’t be used',
    help: 'house.json is broken; the last valid layout is shown read-only until it is fixed.',
  },
  house_newer_version: {
    title: 'Layout from a newer Housebook',
    help: 'house.json was written by a newer version, so it is shown read-only.',
  },
  house_duplicate_id: {
    title: 'Duplicate ids in the layout',
    help: 'Two rooms or floors share an id.',
  },
  house_bad_cell: {
    title: 'Bad tiles in the layout',
    help: 'A tile key in house.json is malformed.',
  },
  house_outside_grid: {
    title: 'Outside the grid',
    help: 'Tiles, placements or openings lie outside the house grid.',
  },
  house_unknown_room: {
    title: 'Tiles of unknown rooms',
    help: 'A tile points to a room that doesn’t exist.',
  },
  house_unknown_finish: {
    title: 'Unknown floor or wall finishes',
    help: 'A room names a finish this version doesn’t know (a typo, a newer catalogue, or a texture that was deleted). It is shown in its plain colour; pick a finish again in the editor.',
  },
  textures_invalid: {
    title: 'Your own textures can’t be read',
    help: 'Textures/textures.json is broken. The last valid list is still used, but no texture can be added or deleted until the file is fixed or removed.',
  },
  texture_missing: {
    title: 'Texture images missing',
    help: 'A texture listed in Textures/textures.json has no image file. Rooms using it show its colour; put the file back, or delete the texture in the editor’s Finish dialog.',
  },
  house_unknown_floor: {
    title: 'Unknown floors',
    help: 'A placement or opening points to a floor that doesn’t exist.',
  },
  house_duplicate_placement: {
    title: 'Items placed twice',
    help: 'An item has more than one placement; the first one is used.',
  },
  note_parse_error: {
    title: 'Notes that can’t be read',
    help: 'The frontmatter is broken or the note is too large. The last good version stays on screen; fix the note in an editor.',
  },
  read_error: {
    title: 'Files that can’t be read',
    help: 'A note or folder couldn’t be read (permissions or I/O). The last good version stays on screen.',
  },
  note_invalid_field: {
    title: 'Invalid fields',
    help: 'One frontmatter field has a value Housebook can’t use; that field is ignored.',
  },
  note_invalid_id: {
    title: 'Invalid housebook_id',
    help: 'The note’s housebook_id is malformed, so the note is ignored.',
  },
  duplicate_id: {
    title: 'Duplicate ids',
    help: 'Two notes have the same housebook_id (often a duplicated note). Only the canonical one is used.',
  },
  conflict_copy: {
    title: 'Sync conflict copies',
    help: 'A sync tool left a conflict copy of a note. Merge it into the original and delete it.',
  },
  not_adopted: {
    title: 'Notes not yet adopted',
    help: 'Tagged #housebook but without a housebook_id. Adopting writes a new id as the first frontmatter line.',
  },
  untagged_typed: {
    title: 'Typed notes without the tag',
    help: 'These notes have a type but no #housebook tag, so Housebook leaves them alone.',
  },
  unknown_type: {
    title: 'Unknown item types',
    help: 'The type isn’t in the catalogue; the item is drawn as a plain box.',
  },
  symlink_outside_root: {
    title: 'Symlinks leaving the data folder',
    help: 'Ignored for safety.',
  },
  missing_note: {
    title: 'Placements without a note',
    help: 'The layout places an item whose note is gone. It is drawn as a ghost on the plan.',
  },
  attachment_missing: {
    title: 'Missing attachments',
    help: 'A note lists an attachment that doesn’t exist.',
  },
  attachment_unsafe: {
    title: 'Unsafe attachments',
    help: 'An attachment link points outside the data folder or to a hidden file; it is not served.',
  },
  attachment_name_collision: {
    title: 'Attachment name clashes',
    help: 'Two attachments of one note have the same name.',
  },
};

const FALLBACK = { title: 'Other problems', help: '' };

export const problemText = (kind: string) =>
  PROBLEM_TEXT[kind as ProblemKind] ?? { ...FALLBACK, title: kind };

export interface ProblemGroup {
  kind: string;
  problems: Problem[];
}

/** Group by kind, keeping the server's order (severity, then path) for groups and entries. */
export function groupProblems(problems: readonly Problem[]): ProblemGroup[] {
  const groups = new Map<string, Problem[]>();
  for (const p of problems) {
    const list = groups.get(p.kind);
    if (list) list.push(p);
    else groups.set(p.kind, [p]);
  }
  return [...groups].map(([kind, list]) => ({ kind, problems: list }));
}

export const SEVERITY_TEXT: Record<string, string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
};
