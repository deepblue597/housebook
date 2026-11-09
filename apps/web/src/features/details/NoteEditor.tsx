/**
 * Edit an item's note in the app (D31): the common fields as a form, the body as Markdown with
 * a preview. Editors only. The draft lives in `useDrafts`, so it survives closing the panel.
 */
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError, fetchItem } from '../../api/client';
import type { Item } from '../../api/types';
import { itemType } from '../../catalog/catalog';
import { useData } from '../../store/data';
import { useDrafts } from './drafts';
import {
  FIELDS,
  type FieldKey,
  type FieldSpec,
  type NoteDraft,
  type ValueKey,
  buildPatch,
  changedKeys,
  rebase,
  serverErrors,
  validate,
} from './noteForm';
import type { MarkdownBodyProps } from './MarkdownBody';
import { Notes } from './Notes';

type Errors = Partial<Record<FieldKey, string>>;

interface Props {
  item: Item;
  draft: NoteDraft;
  /** After a save (`changed`: something was written) or Cancel (`null`). */
  onDone: (changed: boolean | null) => void;
  resolve: MarkdownBodyProps['resolve'];
  onNavigate: (href: string) => void;
}

const labelOf = (k: ValueKey) =>
  k === 'body' ? 'Notes' : (FIELDS.find((f) => f.key === k)?.label ?? k);

function shown(k: ValueKey, v: string): string {
  if (k === 'critical') return v === 'true' ? 'Yes' : v === 'false' ? 'No' : 'Type default';
  return v.trim() === '' ? '(empty)' : v;
}

/** Why a save failed, in words; field errors of a 422 go next to their fields. */
function failure(err: unknown): { text: string; fields?: Errors } {
  if (!(err instanceof ApiError))
    return { text: 'The server couldn’t be reached. Your changes are kept; try again.' };
  switch (err.status) {
    case 403:
      return { text: 'You can only view this house.' };
    case 404:
      return { text: 'This item was deleted elsewhere. Copy what you want to keep, then cancel.' };
    case 409:
      return err.reason === 'unparseable'
        ? { text: 'The note can’t be read right now; fix it in a text editor first.' }
        : { text: err.detail ?? 'The note can’t be written safely right now.' };
    case 413:
      return { text: 'The note is too large to save (4 MB at most).' };
    case 422: {
      const { fields, other } = serverErrors(err.issues);
      return { text: other.join(' ') || 'Fix the marked fields.', fields };
    }
    default:
      return { text: err.detail ?? err.message };
  }
}

function FieldInput({
  spec,
  value,
  error,
  changed,
  unreadable,
  placeholder,
  typeDefault,
  onChange,
}: {
  spec: FieldSpec;
  value: string;
  error: string | undefined;
  changed: boolean;
  unreadable: string | undefined;
  placeholder: string | undefined;
  typeDefault: boolean;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const hint =
    error ??
    (unreadable && !changed
      ? `Currently “${unreadable}”, which isn’t a date. Pick one to replace it.`
      : null) ??
    (spec.kind === 'interval' ? 'e.g. 6m or 1y (days d, weeks w, months m, years y)' : null);
  const common = {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': hint ? hintId : undefined,
  } as const;
  return (
    <div
      className={`ne-field${changed ? ' changed' : ''}${error ? ' bad' : ''}`}
      data-field={spec.key}
    >
      <label htmlFor={id}>{spec.label}</label>
      {spec.kind === 'critical' ? (
        <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Type default ({typeDefault ? 'yes' : 'no'})</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : (
        <input
          {...common}
          type={spec.kind === 'date' ? 'date' : 'text'}
          inputMode={spec.kind === 'url' ? 'url' : undefined}
          autoComplete="off"
          spellCheck={spec.kind === 'text' ? undefined : false}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint && (
        <p id={hintId} className={error ? 'hint err' : 'hint'}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function NoteEditor({ item, draft, onDone, resolve, onNavigate }: Props) {
  const put = useDrafts((s) => s.put);
  const drop = useDrafts((s) => s.drop);
  const updateItem = useData((s) => s.updateItem);
  const [errors, setErrors] = useState<Errors>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const bodyId = useId();

  // Opening the editor puts the cursor in the first field.
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>('input, select')?.focus();
  }, []);

  /** After the next render: focus (and scroll to) what needs the user's attention. */
  const focusSoon = (selector: string) =>
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(selector)?.focus());

  const current = () => useDrafts.getState().drafts[item.id] ?? draft;
  const setValue = (k: ValueKey, v: string) => {
    const d = current();
    put(item.id, { ...d, values: { ...d.values, [k]: v } });
    if (k !== 'body' && errors[k]) setErrors(({ [k]: _fixed, ...rest }) => rest);
  };
  const takeTheirs = (k: ValueKey) => {
    const d = current();
    put(item.id, {
      ...d,
      values: { ...d.values, [k]: d.base[k] },
      conflicts: d.conflicts.filter((c) => c !== k),
    });
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    let d = current();
    const invalid = validate(d);
    if (Object.keys(invalid).length > 0) {
      setErrors(invalid);
      setMsg('Fix the marked fields first.');
      focusSoon('[aria-invalid="true"]');
      return;
    }
    setBusy(true);
    setMsg(null);
    setErrors({});
    try {
      // A 412 means the note was saved elsewhere since `d.etag`: merge and retry, unless the
      // same field changed on both sides (the user decides). A few rounds at most.
      for (let round = 0; round < 3; round++) {
        const patch = buildPatch(d);
        if (!patch) {
          drop(item.id);
          onDone(false);
          return;
        }
        try {
          await updateItem(item.id, patch, d.etag);
          drop(item.id);
          onDone(true);
          return;
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 412)) throw err;
        }
        const latest = await fetchItem(item.id);
        if (!latest) throw new ApiError(404, 'gone');
        d = rebase(d, latest);
        put(item.id, d);
        if (d.conflicts.length > 0) {
          focusSoon('.ne-conflict');
          return;
        }
      }
      setMsg('The note keeps changing elsewhere. Try again in a moment.');
    } catch (err) {
      const f = failure(err);
      setMsg(f.text);
      if (f.fields) {
        setErrors(f.fields);
        focusSoon('[aria-invalid="true"]');
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    drop(item.id);
    onDone(null);
  };

  const n = changedKeys(draft).length;
  const typeDefault = itemType(item.type)?.critical ?? false;
  const fileName = item.path.split('/').pop()?.replace(/\.md$/i, '');
  const changedElsewhere = item.etag !== draft.etag && draft.conflicts.length === 0;

  return (
    <form
      ref={formRef}
      className="note-editor"
      aria-label="Edit note"
      onSubmit={(e) => void save(e)}
      noValidate
    >
      {draft.conflicts.length > 0 && (
        <div className="ne-conflict" role="alert" tabIndex={-1}>
          <p>
            <strong>Changed elsewhere too.</strong> While you were editing, someone saved this note
            with different values for the fields below. Saving keeps yours; use theirs where they
            are right.
          </p>
          <ul>
            {draft.conflicts.map((k) => (
              <li key={k}>
                <span className="k">{labelOf(k)}</span>
                {k === 'body' ? (
                  <details>
                    <summary>Their notes</summary>
                    <pre>{draft.base.body}</pre>
                  </details>
                ) : (
                  <span>
                    Theirs: <b>{shown(k, draft.base[k])}</b> · yours:{' '}
                    <b>{shown(k, draft.values[k])}</b>
                  </span>
                )}
                <button type="button" className="btn" onClick={() => takeTheirs(k)}>
                  Use theirs
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {changedElsewhere && (
        <p className="notice" role="note">
          This note was changed elsewhere while you were editing. Saving keeps both sets of changes;
          if you both changed the same field, you’ll choose.
        </p>
      )}

      <div className="ne-fields">
        {FIELDS.map((spec) => (
          <FieldInput
            key={spec.key}
            spec={spec}
            value={draft.values[spec.key]}
            error={errors[spec.key]}
            changed={draft.values[spec.key] !== draft.base[spec.key]}
            unreadable={draft.unreadable[spec.key]}
            placeholder={
              spec.key === 'name' ? fileName : spec.kind === 'url' ? 'https://' : undefined
            }
            typeDefault={typeDefault}
            onChange={(v) => setValue(spec.key, v)}
          />
        ))}
      </div>

      <div className={`ne-body${draft.values.body !== draft.base.body ? ' changed' : ''}`}>
        <div className="ne-body-head">
          <label htmlFor={bodyId}>Notes (Markdown)</label>
          <div className="ne-tabs" role="group" aria-label="Notes view">
            <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
              Write
            </button>
            <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
              Preview
            </button>
          </div>
        </div>
        {preview ? (
          <div className="ne-preview">
            <Notes body={draft.values.body} resolve={resolve} onNavigate={onNavigate} />
          </div>
        ) : (
          <textarea
            id={bodyId}
            value={draft.values.body}
            rows={14}
            spellCheck
            onChange={(e) => setValue('body', e.target.value)}
          />
        )}
      </div>

      <div className="ne-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={cancel} disabled={busy}>
          {n > 0 ? 'Discard changes' : 'Cancel'}
        </button>
        <span className="muted small">
          {n === 0 ? 'No changes yet' : n === 1 ? '1 change' : `${n} changes`}
        </span>
      </div>
      <p className={`msg${msg ? ' err' : ''}`} role="status">
        {msg ?? ''}
      </p>
    </form>
  );
}
