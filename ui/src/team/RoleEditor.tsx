import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { TeamScope } from '../api/client';
import { CATALOG, activeKeys } from './catalog';
import { LAPTOP_NOTE } from './view';

export const ALL_LOCKED_NOTE = "This built-in role always holds every permission. It can't be renamed or changed.";
export const NAME_LOCKED_NOTE = "This built-in role can't be renamed.";
const NOT_HELD = 'You can only give permissions you hold yourself.';

export interface RoleEditorProps {
  scope: TeamScope;
  /** The form's accessible name, e.g. "New role" or "Edit role: Editor". */
  title: string;
  /**
   * True for a new or duplicated role: a key the viewer lacks may be unticked
   * (removing is not giving) but never ticked. False for an existing role, where
   * every key the viewer lacks stays as it is.
   */
  isNew: boolean;
  initialName: string;
  /** May include inactive keys; only active ones are shown and sent (rule 4). */
  initialKeys: string[];
  /** "all": nothing can change (Owner, Office admin); "name": the name can't change (Office member). */
  locked: 'all' | 'name' | null;
  /** The viewer's own active keys in this scope: they can only give these (S3-14). */
  viewerKeys: string[];
  /** Resolves true when the office accepted the change. Keys are active keys only, in catalog order. */
  onSave: (name: string, keys: string[]) => Promise<boolean>;
  onClose: () => void;
}

/**
 * One role's name and keys, grouped by area. The office decides; disabled
 * toggles only spare the viewer a refusal.
 */
export default function RoleEditor(props: RoleEditorProps) {
  const { scope, title, isNew, locked, viewerKeys, onSave, onClose } = props;
  const active = activeKeys(scope);
  const [name, setName] = useState(props.initialName);
  const [keys, setKeys] = useState(() => new Set(props.initialKeys.filter((k) => active.includes(k))));
  const [saving, setSaving] = useState(false);
  const id = useId();
  const readOnly = locked === 'all';
  const nameLocked = locked !== null;
  const heading = useRef<HTMLHeadingElement>(null);
  const nameField = useRef<HTMLInputElement>(null);

  // Focus moves into the editor when it opens: the name, or the heading when the name is fixed.
  useEffect(() => { (nameLocked ? heading.current : nameField.current)?.focus(); }, [nameLocked]);

  const toggle = (key: string) => setKeys((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || saving) return;
    setSaving(true);
    const ok = await onSave(name.trim(), active.filter((k) => keys.has(k)));
    setSaving(false);
    if (ok) onClose();
  };

  const areas = CATALOG
    .filter((a) => a.scope === scope)
    .map((a) => ({ ...a, permissions: a.permissions.filter((p) => p.active) }))
    .filter((a) => a.permissions.length > 0);

  /** A key the viewer lacks: fixed on an existing role; on a new one it may only be unticked. */
  const isDisabled = (key: string) => readOnly || (!viewerKeys.includes(key) && (!isNew || !keys.has(key)));
  const notHeldShown = !readOnly && areas.some((a) => a.permissions.some((p) => isDisabled(p.key)));
  const notHeldId = `${id}-not-held`;

  return (
    <form
      aria-label={title}
      onSubmit={submit}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 space-y-4"
    >
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold break-words focus:outline-none">{title}</h2>
      {readOnly && <p className="text-sm text-gray-600 dark:text-gray-400">{ALL_LOCKED_NOTE}</p>}

      <div className="space-y-1">
        <label htmlFor={`${id}-name`} className="block text-sm font-medium">Name</label>
        <input
          id={`${id}-name`}
          ref={nameField}
          type="text"
          value={name}
          readOnly={nameLocked}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          className="w-full max-w-sm rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-sm read-only:bg-gray-100 dark:read-only:bg-gray-800"
        />
        {locked === 'name' && <p className="text-sm text-gray-600 dark:text-gray-400">{NAME_LOCKED_NOTE}</p>}
      </div>

      {notHeldShown && <p id={notHeldId} className="text-sm text-gray-600 dark:text-gray-400">{NOT_HELD}</p>}

      {areas.map((a) => (
        <fieldset key={a.area} className="space-y-2">
          <legend className="text-sm font-semibold">{a.label}</legend>
          {a.permissions.map((p) => {
            const disabled = isDisabled(p.key);
            const notHeld = disabled && !readOnly;
            return (
              <label
                key={p.key}
                title={notHeld ? NOT_HELD : undefined}
                className={`flex items-start gap-3 text-sm ${disabled ? 'opacity-60' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={keys.has(p.key)}
                  disabled={disabled}
                  onChange={() => toggle(p.key)}
                  aria-labelledby={`${id}-${p.key}-label`}
                  aria-describedby={notHeld ? `${id}-${p.key} ${notHeldId}` : `${id}-${p.key}`}
                  className="mt-1"
                />
                <span>
                  <span id={`${id}-${p.key}-label`} className="font-medium">{p.label}</span>
                  <span id={`${id}-${p.key}`} className="block text-gray-500">
                    {p.description} <code className="font-mono text-xs">{p.key}</code>
                    {p.checkedOn === 'laptop' && <span className="block text-xs">{LAPTOP_NOTE}</span>}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}

      <div className="flex gap-2">
        {readOnly ? (
          <button type="button" onClick={onClose} className="px-3 py-1 rounded-md border border-gray-300 dark:border-gray-700 text-sm hover:bg-gray-100 dark:hover:bg-gray-900">
            Close
          </button>
        ) : (
          <>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="px-3 py-1 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Save
            </button>
            <button type="button" onClick={onClose} className="px-3 py-1 rounded-md border border-gray-300 dark:border-gray-700 text-sm hover:bg-gray-100 dark:hover:bg-gray-900">
              Cancel
            </button>
          </>
        )}
      </div>
    </form>
  );
}
