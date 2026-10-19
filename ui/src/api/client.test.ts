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

// RnR S3 (Review Focus 4): the web guard's own 403 means reload; any other error
// body is the post office's (or the server's) sentence, shown as it arrives.
describe('team and refused calls', () => {
  const reply = (status: number, body: unknown) => {
    const f = vi.fn(async (_url: string, _opts?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    globalThis.fetch = f as any;
    return f;
  };

  it('the guard\'s {error:"forbidden"} 403 tells the user to reload', async () => {
    reply(403, { error: 'forbidden' });
    await expect(api.teamOverview()).rejects.toThrow(RELOAD_MESSAGE);
  });

  it('any other 403 carries its own text and status', async () => {
    const msg = 'You need "Manage roles" (role.manage) in SH to do this';
    reply(403, { error: msg });
    const err = await api.teamSetMember({ scope: 'project', project: 'P1', device: 'd1', role: 'Reader' }).catch((e) => e);
    expect(err.message).toBe(msg);
    expect(err.status).toBe(403);
  });

  it('a 409 or 503 keeps its text and status, on GET too', async () => {
    reply(409, { error: '2 members hold Lead. Give them another role first' });
    const err = await api.teamDeleteRole({ scope: 'project', project: 'P1', role: 'R1' }).catch((e) => e);
    expect([err.status, err.message]).toEqual([409, '2 members hold Lead. Give them another role first']);
    reply(503, { error: "The post office can't be reached right now." });
    const down = await api.teamProject('P1').catch((e) => e);
    expect([down.status, down.message]).toEqual([503, "The post office can't be reached right now."]);
  });

  it('an error body that is not JSON gives a plain sentence with the status', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })) as any;
    const err = await api.teamProject('P1').catch((e) => e);
    expect([err.status, err.message]).toEqual([502, 'Something went wrong (HTTP 502). Try again.']);
    globalThis.fetch = vi.fn(async () => new Response('oops', { status: 403 })) as any;
    const post = await api.refusedDelete('01R').catch((e) => e);
    expect([post.status, post.message]).toEqual([403, 'Something went wrong (HTTP 403). Try again.']);
  });

  it('team calls hit the right routes with the right bodies', async () => {
    const f = reply(200, { ok: true });
    await api.teamProject('01ABC');
    await api.teamOffice();
    await api.teamSetMember({ scope: 'office', device: 'd2', role: 'Office member' });
    await api.teamRemoveMember({ project: 'P1', device: 'd2' });
    await api.teamCreateRole({ scope: 'project', project: 'P1', name: 'Lead', keys: ['note.view'] });
    await api.teamUpdateRole({ scope: 'office', role: 'R9', keys: ['office.project.create'] });
    const calls = f.mock.calls.map(([u, o]: any) => [u, o?.method ?? 'GET', o?.body ? JSON.parse(o.body) : undefined]);
    expect(calls).toEqual([
      ['/api/team/project?ulid=01ABC', 'GET', undefined],
      ['/api/team/office', 'GET', undefined],
      ['/api/team/member/set', 'POST', { scope: 'office', device: 'd2', role: 'Office member' }],
      ['/api/team/member/remove', 'POST', { project: 'P1', device: 'd2' }],
      ['/api/team/role/create', 'POST', { scope: 'project', project: 'P1', name: 'Lead', keys: ['note.view'] }],
      ['/api/team/role/update', 'POST', { scope: 'office', role: 'R9', keys: ['office.project.create'] }],
    ]);
  });

  it('refused calls: list, copy(id, to), delete(id)', async () => {
    const f = reply(200, { ok: true });
    await api.refusedList();
    await api.refusedCopy('01R', 'MY');
    await api.refusedDelete('01R');
    const calls = f.mock.calls.map(([u, o]: any) => [u, o?.method ?? 'GET', o?.body ? JSON.parse(o.body) : undefined]);
    expect(calls).toEqual([
      ['/api/refused', 'GET', undefined],
      ['/api/refused/copy', 'POST', { id: '01R', to: 'MY' }],
      ['/api/refused/delete', 'POST', { id: '01R' }],
    ]);
  });
});
