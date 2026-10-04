// file: ui/src/sync/useSyncOverview.ts
import { useEffect, useState } from 'react';
import { syncStatus, type SyncOverview } from '../api/client';

/** One read of the sync overview for labels and notes (the bar does its own polling). */
export function useSyncOverview(): SyncOverview | null {
  const [o, setO] = useState<SyncOverview | null>(null);
  useEffect(() => { syncStatus().then(setO).catch(() => setO(null)); }, []);
  return o;
}
