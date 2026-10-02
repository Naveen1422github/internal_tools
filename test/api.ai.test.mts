import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { startTestServer, seedEntry } from './helpers/server.mjs';
let ai; // dynamic import: ai.js reaches getDb() at load, so env must be set first (D9)
let srv;
let originalApiKey;
let originalGrokApiKey;

before(async () => {
  srv = await startTestServer(); // sets COLLAB_DB_PATH + creates the DB
  ai = await import('../server/dist/tools/ai.js');
  originalApiKey = process.env.GROQ_API_KEY;
  originalGrokApiKey = process.env.GROK_API_KEY;
});

after(() => {
  srv.close();
});

afterEach(() => {
  process.env.GROQ_API_KEY = originalApiKey;
  process.env.GROK_API_KEY = originalGrokApiKey;
  ai.testHooks.mockCallGroq = null;
});

test('1. Missing key -> 503', async () => {
  delete process.env.GROQ_API_KEY;
  delete process.env.GROK_API_KEY;

  const res = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })
  });

  assert.strictEqual(res.status, 503);
  const json: any = await res.json();
  assert.strictEqual(json.error, 'AI not configured (set GROQ_API_KEY)');
});

test('2. Model returns answer envelope -> endpoint returns { answer }', async () => {
  process.env.GROQ_API_KEY = 'mock-key';

  ai.testHooks.mockCallGroq = async (messages) => {
    return JSON.stringify({ type: 'answer', text: 'Hello, this is a mock answer.' });
  };

  const res = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })
  });

  assert.strictEqual(res.status, 200);
  const json: any = await res.json();
  assert.strictEqual(json.answer, 'Hello, this is a mock answer.');
  assert.ok(Array.isArray(json.searches));
  assert.strictEqual(json.searches.length, 0);
});

test('3. Model returns search then answer -> server runs FTS search and second call sees results', async () => {
  process.env.GROQ_API_KEY = 'mock-key';

  const entryId = await seedEntry(srv.db, {
    category: 'Reference',
    type: 'decision',
    title: 'Testing FTS',
    summary: 'Mock summary for FTS test.',
    description: 'Detailed description about Testing FTS content.'
  });

  let callCount = 0;
  ai.testHooks.mockCallGroq = async (messages) => {
    callCount++;
    if (callCount === 1) {
      return JSON.stringify({
        type: 'search',
        query: 'Testing FTS',
        filters: {}
      });
    } else {
      const lastUserMessage = messages[messages.length - 1];
      assert.strictEqual(lastUserMessage.role, 'user');
      assert.ok(lastUserMessage.content.includes('Testing FTS'));
      return JSON.stringify({
        type: 'answer',
        text: 'I found the entry titled Testing FTS.'
      });
    }
  };

  const res = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'find Testing FTS' }] })
  });

  assert.strictEqual(res.status, 200);
  const json: any = await res.json();
  assert.strictEqual(json.answer, 'I found the entry titled Testing FTS.');
  assert.strictEqual(json.searches.length, 1);
  assert.strictEqual(json.searches[0].query, 'Testing FTS');
  assert.ok(json.searches[0].resultCount >= 1);
});

test('4. Model returns draft with too-long summary -> validation.ok === false, NO DB write', async () => {
  process.env.GROQ_API_KEY = 'mock-key';

  const countBefore = (srv.db.prepare('SELECT COUNT(*) as c FROM entries').get() as any).c;
  const longSummary = 'a'.repeat(201);

  ai.testHooks.mockCallGroq = async (messages) => {
    return JSON.stringify({
      type: 'draft',
      entry: {
        type: 'decision',
        title: 'Draft Title',
        summary: longSummary,
        description: 'Draft Description',
        category: 'Reference'
      }
    });
  };

  const res = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'propose draft' }] })
  });

  assert.strictEqual(res.status, 200);
  const json: any = await res.json();
  assert.strictEqual(json.validation.ok, false);
  assert.ok(json.validation.errors.some((e: any) => e.includes('summary exceeds 200 chars')));
  assert.strictEqual(json.draft.title, 'Draft Title');

  const countAfter = (srv.db.prepare('SELECT COUNT(*) as c FROM entries').get() as any).c;
  assert.strictEqual(countAfter, countBefore, 'Entries count should remain unchanged');
});

test('5. Model returns malformed (non-JSON) content -> graceful answer, no throw', async () => {
  process.env.GROQ_API_KEY = 'mock-key';

  ai.testHooks.mockCallGroq = async (messages) => {
    return 'This is a completely malformed response and is not JSON at all!';
  };

  const res = await fetch(srv.baseUrl + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })
  });

  assert.strictEqual(res.status, 200);
  const json: any = await res.json();
  assert.strictEqual(json.answer, "I couldn't form a structured response from the model's output.");
  assert.ok(Array.isArray(json.searches));
  assert.strictEqual(json.searches.length, 0);
});
