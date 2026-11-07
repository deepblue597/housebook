/**
 * Resize the house grid on any side (D17b). Growing north or west shifts everything so nothing
 * moves on the plan; shrinking lists what would be cut off (painted tiles, items, doors and
 * windows) and needs an explicit confirmation. One undo step. The tile size isn't editable.
 */
import { type FormEvent, useMemo, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import {
  type ResizeDeltas,
  lossIsEmpty,
  lossKeys,
  resizeLayout,
  resizedSize,
  sizeAllowed,
} from '../../domain/layout';
import { EDITOR } from '../../strings/editor';
import { useData } from '../../store/data';
import { applyContext, useEditor } from '../../store/editor';

const SIDES = ['n', 'e', 's', 'w'] as const;

export function ResizeDialog({ onClose }: { onClose: () => void }) {
  const model = useData((s) => s.model);
  const resize = useEditor((s) => s.resize);
  const [text, setText] = useState<Record<(typeof SIDES)[number], string>>({
    n: '0',
    e: '0',
    s: '0',
    w: '0',
  });
  /** The loss the user ticked "Remove these" for; a different loss list isn't confirmed (M5-04). */
  const [confirmedLoss, setConfirmedLoss] = useState<string | null>(null);
  const house = model?.snapshot.house;

  const by: ResizeDeltas | null = useMemo(() => {
    const out = {} as ResizeDeltas;
    for (const k of SIDES) {
      const v = text[k].trim() === '' ? 0 : Number(text[k]);
      if (!Number.isInteger(v)) return null;
      out[k] = v;
    }
    return out;
  }, [text]);

  const preview = useMemo(() => {
    if (!house || !by) return null;
    const size = resizedSize(house.grid, by);
    if (!sizeAllowed(size)) return { size, valid: false as const };
    const { loss } = resizeLayout(house, by, applyContext().footprintOf);
    return { size, valid: true as const, loss };
  }, [house, by]);

  if (!house || !model) return null;
  const changed = !!by && SIDES.some((k) => by[k] !== 0);
  const loss = preview?.valid ? preview.loss : null;
  const hasLoss = !!loss && !lossIsEmpty(loss);
  const lossNow = loss ? lossKeys(loss).join('|') : '';
  const confirmed = confirmedLoss !== null && confirmedLoss === lossNow;
  const canApply = changed && !!preview?.valid && (!hasLoss || confirmed);

  const lossRooms = () => {
    const n = new Map<string, number>();
    for (const c of loss?.cells ?? []) n.set(c.roomId, (n.get(c.roomId) ?? 0) + 1);
    return [...n].map(([id, k]) => `${model.rooms.get(id)?.name ?? id} ${k}`).join(', ');
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canApply || !by || !loss) return;
    // Close through <dialog> so focus goes back to the button that opened it.
    if (resize(by, hasLoss ? confirmedLoss!.split('|') : []))
      e.currentTarget.closest('dialog')?.close();
  };

  return (
    <Dialog title={EDITOR.resizeTitle} onClose={onClose} className="resize-dialog">
      <form className="resize-form" onSubmit={submit}>
        <p>{EDITOR.resizeIntro(house.grid.width, house.grid.depth, house.grid.tileSize)}</p>
        <div className="sides">
          {SIDES.map((k) => (
            <label key={k} className={`side side-${k}`}>
              <span>{EDITOR.sides[k]}</span>
              <input
                type="number"
                inputMode="numeric"
                step={1}
                value={text[k]}
                aria-label={EDITOR.sideLabel(EDITOR.sides[k])}
                onChange={(e) => {
                  setText((t) => ({ ...t, [k]: e.target.value }));
                  setConfirmedLoss(null);
                }}
              />
            </label>
          ))}
        </div>
        <p aria-live="polite" className="resize-size">
          {!by || (preview && !preview.valid)
            ? EDITOR.resizeInvalid
            : !changed
              ? EDITOR.resizeNoChange
              : EDITOR.resizeNew(preview!.size.width, preview!.size.depth)}
        </p>
        {changed && by && (by.n > 0 || by.w > 0) && (
          <p className="muted small">{EDITOR.resizeShift}</p>
        )}
        {hasLoss && loss && (
          <div className="resize-loss" role="alert">
            <p>{EDITOR.resizeLoss}</p>
            <ul>
              {loss.cells.length > 0 && (
                <li>{EDITOR.resizeLossCells(loss.cells.length, lossRooms())}</li>
              )}
              {loss.placements.length > 0 && (
                <li>
                  {EDITOR.resizeLossItems(
                    loss.placements
                      .map((p) => model.items.get(p.itemId)?.name ?? p.itemId)
                      .join(', '),
                  )}
                </li>
              )}
              {loss.openings.length > 0 && (
                <li>{EDITOR.resizeLossOpenings(loss.openings.length)}</li>
              )}
            </ul>
            <label className="check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmedLoss(e.target.checked ? lossNow : null)}
              />
              {EDITOR.resizeConfirm}
            </label>
          </div>
        )}
        <p className="muted small">{EDITOR.tileSizeFixed}</p>
        <div className="row end">
          <button
            type="button"
            className="btn"
            onClick={(e) => e.currentTarget.closest('dialog')?.close()}
          >
            {EDITOR.resizeCancel}
          </button>
          <button type="submit" className="btn primary" disabled={!canApply}>
            {hasLoss ? EDITOR.resizeApplyLoss : EDITOR.resizeApply}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
