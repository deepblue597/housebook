import { iconFor } from './icons';

/** Icon as standalone `<svg>` (lists, panels). Decorative: the label sits next to it. */
export function TypeIcon({ type, className = 'ico' }: { type: string | null; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {iconFor(type)}
    </svg>
  );
}
