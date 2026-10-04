import { collabKey, keyMissingMessage } from '../api/client';

/** One line when this page was not served by the collab web server (no access key). */
export default function KeyMissingNotice() {
  const msg = keyMissingMessage(collabKey(), import.meta.env.DEV);
  if (!msg) return null;
  return (
    <div role="alert" className="px-4 py-2 text-sm bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200">
      {msg}
    </div>
  );
}
