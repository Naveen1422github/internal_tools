import { CATALOG } from './catalog';
import { LAPTOP_NOTE, holdersOf, memberName, orderRoles, type TeamTabProps } from './view';

/**
 * The "Who can do what" tab (S3-8): roles against permissions, read-only. The
 * spec drew members against keys; by the user's ruling each column is a role,
 * with its members' names under the role's name. Active keys only (rule 4).
 */
export default function Matrix({ scope, roster }: TeamTabProps) {
  const roles = orderRoles(roster.roles);
  const areas = CATALOG
    .filter((a) => a.scope === scope)
    .map((a) => ({ ...a, permissions: a.permissions.filter((p) => p.active) }))
    .filter((a) => a.permissions.length > 0);

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto max-w-full">
      <table className="text-sm">
        <caption className="caption-top px-3 py-2 text-left text-sm text-gray-500">
          Each column is a role; the names under it are the members who hold it.
        </caption>
        <thead className="bg-gray-50 dark:bg-gray-900 text-left align-bottom">
          <tr>
            <th scope="col" className="px-3 py-2 text-xs font-semibold text-gray-500">Permission</th>
            {roles.map((r) => {
              const holders = holdersOf(r, roster.members);
              return (
                <th key={r.ulid} scope="col" className="px-3 py-2 min-w-32 font-normal">
                  <span data-role-name className="block font-semibold">{r.name}</span>
                  <span className="block text-xs text-gray-500">
                    {holders.length ? holders.map(memberName).join(', ') : 'No members'}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        {areas.map((a) => (
          <tbody key={a.area} className="divide-y divide-gray-200 dark:divide-gray-800 border-t border-gray-200 dark:border-gray-800">
            <tr className="bg-gray-50/50 dark:bg-gray-900/50">
              <th scope="rowgroup" colSpan={roles.length + 1} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                {a.label}
              </th>
            </tr>
            {a.permissions.map((p) => (
              <tr key={p.key}>
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <span className="block">{p.label}</span>
                  <code className="block font-mono text-xs text-gray-500">{p.key}</code>
                  {p.checkedOn === 'laptop' && <span className="block text-xs text-gray-500">{LAPTOP_NOTE}</span>}
                </th>
                {roles.map((r) => (
                  <td key={r.ulid} className="px-3 py-2 text-center">
                    {r.keys.includes(p.key) ? (
                      <><span aria-hidden="true">✓</span><span className="sr-only">Allowed</span></>
                    ) : (
                      <span className="sr-only">Not allowed</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
