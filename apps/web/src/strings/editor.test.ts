import { describe, expect, it } from 'vitest';
import { EDITOR } from './editor';

describe('what a floor removal or resize takes: openings by kind (D51)', () => {
  const o = (kind: string) => ({ kind });
  it('names each kind with its count', () => {
    expect(EDITOR.floorLossOpenings([o('door')])).toBe('1 door');
    expect(EDITOR.floorLossOpenings([o('window'), o('window')])).toBe('2 windows');
    expect(EDITOR.resizeLossOpenings([o('door'), o('open'), o('window'), o('open')])).toBe(
      '1 door, 1 window and 2 open walls',
    );
    expect(EDITOR.resizeLossOpenings([o('open')])).toBe('1 open wall');
  });
});
