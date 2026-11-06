/** The ⚠ count in the top bar; opens the problems panel (a lazy chunk). */
import { Suspense, lazy, useState } from 'react';
import { useData } from '../../store/data';

const ProblemsPanel = lazy(() => import('./ProblemsPanel'));

export function ProblemsButton() {
  const count = useData((s) => s.problemCount);
  const [open, setOpen] = useState(false);
  if (count === 0 && !open) return null;
  const text = `${count} data ${count === 1 ? 'problem' : 'problems'}`;
  return (
    <>
      {count > 0 && (
        <button
          type="button"
          className="problems"
          aria-haspopup="dialog"
          aria-label={`${text}. Show`}
          title={text}
          onClick={() => setOpen(true)}
        >
          <span aria-hidden="true">⚠ {count}</span>
        </button>
      )}
      {open && (
        <Suspense fallback={null}>
          <ProblemsPanel
            onClose={() => {
              setOpen(false);
              // The badge is the focus-return target; at zero problems it is gone (every problem
              // was fixed in the panel), so focus the search box instead of dropping to <body>.
              const active = document.activeElement;
              if (!active || active === document.body || active.closest('dialog'))
                document.querySelector<HTMLElement>('header [role="combobox"]')?.focus();
            }}
          />
        </Suspense>
      )}
    </>
  );
}
