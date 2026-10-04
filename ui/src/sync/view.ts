// file: ui/src/sync/view.ts
import type { SyncOverview } from '../api/client';

// Pure view logic for sync in the web UI (spec part 2). Components stay thin;
// this file is what the tests pin down. Plain words, no sync jargon.

export function ago(iso: string | null, now: Date): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

export function barView(o: SyncOverview, now: Date): null | { tone: 'ok' | 'warn' | 'bad'; text: string; fix: string | null } {
  if (!o.enabled) return null;
  const contact = `last contact ${ago(o.lastContactAt, now)}`;
  switch (o.health) {
    case 'ok':
      return { tone: 'ok', text: `● Sharing on · ${contact} · nothing waiting to send`, fix: null };
    case 'behind': {
      const parts = ['● Behind', contact];
      parts.push(o.unsent > 0 ? `${changes(o.unsent)} waiting to send` : 'nothing waiting to send');
      if (o.courier.state === 'offline' || o.courier.state === 'starting') parts.push('the courier is retrying');
      return { tone: 'warn', text: parts.join(' · '), fix: null };
    }
    case 'not-syncing':
      return { tone: 'bad', text: `● Not syncing · the courier is not running · ${changes(o.unsent)} waiting`, fix: 'how to fix: run collab sync start' };
    case 'needs-update':
      return { tone: 'bad', text: `● Not syncing · ${o.courier.lastError ?? 'update this laptop'}`, fix: 'how to fix: git pull, npm run build, npm run migrate, then restart collab' };
    case 'revoked':
      return { tone: 'bad', text: '● Not syncing · this laptop was removed from the team · ask the post office owner for a new join code', fix: null };
    default:
      return { tone: 'bad', text: '● Sync status unknown', fix: 'how to fix: run collab sync status in a terminal' };
  }
}
