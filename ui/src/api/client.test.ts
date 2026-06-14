import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as api from './client';

describe('api client', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, results: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    ) as any;
  });

  it('search builds a query string from params', async () => {
    await api.search({ q: 'auth', category: 'Reference', module: 'collab' });
    const url = (globalThis.fetch as any).mock.calls[0][0] as string;
    expect(url).toContain('/api/collab/search?');
    expect(url).toContain('q=auth');
    expect(url).toContain('category=Reference');
    expect(url).toContain('module=collab');
  });

  it('supersede POSTs ids and by in the body', async () => {
    await api.supersede([1, 2], 3);
    const [url, opts] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('/api/collab/entry/supersede');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ ids: [1, 2], by: 3 });
  });

  it('stats GETs the stats endpoint', async () => {
    await api.stats();
    expect((globalThis.fetch as any).mock.calls[0][0]).toBe('/api/collab/stats');
  });
});
