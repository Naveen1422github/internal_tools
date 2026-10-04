import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as api from './client';
import { aiChat, isDraft, collabKey, resetCollabKeyForTests, keyMissingMessage, RELOAD_MESSAGE, type AiResponse } from './client';

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

  describe('access key', () => {
    afterEach(() => { delete (globalThis as any).document; resetCollabKeyForTests(); });
    const withMeta = (content: string | null) => {
      (globalThis as any).document = {
        querySelector: (sel: string) =>
          sel === 'meta[name="collab-key"]' && content !== null ? { getAttribute: () => content } : null,
      };
      resetCollabKeyForTests();
    };

    it('GET and POST send X-Collab-Key from the meta tag', async () => {
      withMeta('k123');
      await api.stats();
      await api.supersede([1], 2);
      const [, getOpts] = (globalThis.fetch as any).mock.calls[0];
      const [, postOpts] = (globalThis.fetch as any).mock.calls[1];
      expect(getOpts.headers['X-Collab-Key']).toBe('k123');
      expect(postOpts.headers['X-Collab-Key']).toBe('k123');
      expect(postOpts.headers['Content-Type']).toBe('application/json');
    });

    it('no meta tag: no header, and collabKey() is null', async () => {
      withMeta(null);
      await api.stats();
      const [, opts] = (globalThis.fetch as any).mock.calls[0];
      expect(opts.headers['X-Collab-Key']).toBeUndefined();
      expect(collabKey()).toBeNull();
    });

    it('a 403 tells the user to reload', async () => {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })) as any;
      await expect(api.stats()).rejects.toThrow(RELOAD_MESSAGE);
      await expect(api.supersede([1], 2)).rejects.toThrow(RELOAD_MESSAGE);
    });

    it('keyMissingMessage: only when the key is missing and not in dev', () => {
      expect(keyMissingMessage(null, false)).toMatch(/Restart the collab web server and reload/);
      expect(keyMissingMessage(null, true)).toBeNull();
      expect(keyMissingMessage('k', false)).toBeNull();
    });
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
