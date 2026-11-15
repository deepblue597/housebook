import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildModel } from '../../store/model';
import { fridge, heater, snapshot } from '../../test/fixtures';
import { PlanSvg } from './PlanSvg';

describe('PlanSvg inconsistent states (DESIGN 15.2)', () => {
  const snap = {
    ...snapshot,
    items: [{ ...fridge, stale: true, parseError: 'bad YAML' }, heater],
    house: {
      ...snapshot.house!,
      placements: [
        { itemId: 'it_fridge', floorId: 'fl_0', x: 0, y: 0, rotation: 0 as const },
        { itemId: 'it_gone', floorId: 'fl_0', x: 1, y: 0, rotation: 0 as const },
      ],
    },
  };
  const model = buildModel(snap);
  const onItem = vi.fn();
  const draw = () =>
    render(
      <svg>
        <PlanSvg
          model={model}
          floor={model.floors[0]!}
          theme="light"
          selectedItemId={null}
          selectedRoomId={null}
          matches={null}
          onItem={onItem}
          onRoom={() => {}}
        />
      </svg>,
    );

  it('draws a placement without a note as a labelled ghost that opens like an item', () => {
    draw();
    const ghost = screen.getByRole('button', { name: 'Note missing, Kitchen, it_gone' });
    expect(ghost).toHaveAttribute('data-ghost-id', 'it_gone');
    expect(ghost).toHaveTextContent('note missing');
    ghost.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onItem).toHaveBeenCalledWith('it_gone');
  });

  it('marks a stale item but keeps showing it', () => {
    draw();
    const item = screen.getByRole('button', { name: /^Fridge, Kitchen, note can’t be read/ });
    expect(item).toHaveClass('stale');
    expect(item.querySelector('.mark.stale')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Water heater/ })).not.toHaveClass('stale');
  });
});

describe('open walls (D51)', () => {
  const draw = (
    openings: { floorId: string; x: number; y: number; side: 'n' | 'w'; kind: 'open' }[],
  ) => {
    const model = buildModel({ ...snapshot, house: { ...snapshot.house!, openings } });
    return render(
      <svg>
        <PlanSvg
          model={model}
          floor={model.floors[0]!}
          theme="light"
          selectedItemId={null}
          selectedRoomId={null}
          matches={null}
          onItem={() => {}}
          onRoom={() => {}}
        />
      </svg>,
    ).container;
  };

  it('draws a dashed line instead of the wall between two rooms', () => {
    // Kitchen (0,0)-(1,0) | Bathroom (2,0): the wall is the w edge of (2,0).
    expect(draw([]).querySelector('.wall-in')).toHaveAttribute('d', 'M80 0L80 40');
    const c = draw([{ floorId: 'fl_0', x: 2, y: 0, side: 'w', kind: 'open' }]);
    expect(c.querySelector('.wall-in')).toHaveAttribute('d', '');
    expect(c.querySelector('.wall-open')).toHaveAttribute('d', 'M80 0L80 40');
    expect(c.querySelector('.door, .window')).toBeNull(); // not drawn as a door or window
  });
});
