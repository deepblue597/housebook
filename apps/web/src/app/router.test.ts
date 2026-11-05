import { describe, expect, it } from 'vitest';
import { itemPath, selectionFromPath } from './router';

describe('deep links', () => {
  it('round-trips /i/<id>', () => {
    expect(selectionFromPath(itemPath('it_7f3k2a'))).toEqual({ kind: 'item', id: 'it_7f3k2a' });
    expect(selectionFromPath('/i/it_x/')).toEqual({ kind: 'item', id: 'it_x' });
  });
  it('ignores other paths and bad encodings', () => {
    expect(selectionFromPath('/')).toBeNull();
    expect(selectionFromPath('/i/')).toBeNull();
    expect(selectionFromPath('/i/%E0%A4%A')).toBeNull();
  });
});
