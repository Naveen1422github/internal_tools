import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as api from './client';
import { aiChat, isDraft, type AiResponse } from './client';

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

describe('aiChat', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs message history to /api/ai/chat and returns the envelope', async () => {
    const answer: AiResponse = { answer: 'hello **world**', searches: [] };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const res = await aiChat([{ role: 'user', content: 'hi' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/chat',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }),
    );
    expect(res).toEqual(answer);
    expect(isDraft(res)).toBe(false);
  });

  it('isDraft narrows a draft envelope', () => {
    const draft: AiResponse = { draft: { type: 'gotcha', title: 'x', summary: 'y' }, validation: { ok: true, errors: [] }, searches: [] };
    expect(isDraft(draft)).toBe(true);
  });
});
