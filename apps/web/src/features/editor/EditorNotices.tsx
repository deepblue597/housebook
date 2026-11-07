/**
 * Editor messages: dropped edits after a replay, undo that no longer applies, edits that
 * aren't possible. Warnings and errors stay until dismissed (no silent loss, DESIGN 15.2);
 * info messages go away after a few seconds.
 */
import { useEffect } from 'react';
import { EDITOR } from '../../strings/editor';
import { useEditor } from '../../store/editor';

const INFO_MS = 6000;

export function EditorNotices() {
  const notices = useEditor((s) => s.notices);
  const dismiss = useEditor((s) => s.dismiss);

  useEffect(() => {
    const timers = notices
      .filter((n) => n.tone === 'info')
      .map((n) => setTimeout(() => dismiss(n.id), INFO_MS));
    return () => timers.forEach(clearTimeout);
  }, [notices, dismiss]);

  return (
    <div className="ed-notices" aria-label={EDITOR.noticesLabel} role="region">
      {/* Always in the page, so screen readers announce what is added to it. */}
      <ul role="log" aria-live="polite">
        {notices.map((n) => (
          <li key={n.id} className={`ed-notice ${n.tone}`} data-tone={n.tone}>
            <p>{n.text}</p>
            <button
              type="button"
              className="icon-btn"
              aria-label={EDITOR.dismiss}
              onClick={() => dismiss(n.id)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
