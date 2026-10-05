import { KIND_BY_TYPE, CATEGORY_BY_TYPE, SLUG_REGEX, getDb } from '@collab-mcp/core';
import { runSearch } from './collab.js';
import http from 'node:http';

// Test seam: a holder object so ESM consumers can inject a mock (the namespace
// binding is read-only, but the object's property is mutable). See api.ai.test.mts.
export const testHooks: { mockCallGroq: ((messages: any[]) => Promise<string>) | null } = { mockCallGroq: null };

export async function callGroq(messages: any[], { temperature = 0.3 } = {}): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY || process.env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY not configured');
  }

  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const apiUrl = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_completion_tokens: 2048,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq API error (${response.status}): ${errorText}`);
  }

  const data: any = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

export function parseJsonEnvelope(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    // Try extracting from markdown code block
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch {}
    }
    // Try finding JSON object in text
    const objectMatch = content.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {}
    }
    throw new Error('Could not parse JSON from AI response');
  }
}

export async function handleAiChat(req: http.IncomingMessage, res: http.ServerResponse, db: any, options: any = {}): Promise<any> {
  const body = options.body || {};
  const send = options.send;
  const messages = body.messages || [];

  const apiKey = process.env.GROQ_API_KEY || process.env.GROK_API_KEY;
  if (!apiKey) {
    if (send) {
      return send(503, { error: 'AI not configured (set GROQ_API_KEY)' });
    }
    throw new Error('AI not configured (set GROQ_API_KEY)');
  }

  const customCallGroq = options.callGroq || testHooks.mockCallGroq || callGroq;
  const maxIters = parseInt(process.env.AI_MAX_TOOL_ITERS || '3', 10);

  const systemPrompt = `You are an AI assistant for a collaborative workspace re-design tool.
Your job is to assist the user by reading the knowledge base and proposing entries/edits as drafts.
You can ONLY search and get entries; you cannot write to the database.

You must ALWAYS reply with EXACTLY ONE JSON envelope. Do not wrap it in any markdown or include any conversational prose before or after the JSON.
Your JSON response must match one of the following schemas:

To answer the user's question directly:
{ "type": "answer", "text": "Your markdown answer text here" }

To search the database using Full-Text Search (FTS) and optional filters:
{ "type": "search", "query": "search query terms", "filters": { "module": "optional-module-slug", "type": "optional-type", "category": "optional-category", "since": "optional-date-string" } }

To propose a draft entry for approval (it will be validated but NOT written to the DB):
{ "type": "draft", "entry": { "type": "handoff|review|proposal|counter|decision|gotcha|session-note|changelog", "title": "entry title", "summary": "brief summary (max 200 chars)", "description": "detailed description", "module": "optional-primary-module-slug", "modules": ["optional", "additional", "module", "slugs"], "category": "optional (defaults based on type)" } }

You can perform up to ${maxIters} search steps before answering. Keep searches focused and use the results to answer the user's query or construct the draft entry.`;

  const llmMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  const searches: any[] = [];
  let currentIteration = 0;
  let finalResponse = null;

  while (currentIteration < maxIters) {
    try {
      const content = await customCallGroq(llmMessages);
      llmMessages.push({ role: 'assistant', content });

      let envelope;
      try {
        envelope = parseJsonEnvelope(content);
      } catch (err) {
        finalResponse = {
          answer: "I couldn't form a structured response from the model's output.",
          searches
        };
        break;
      }

      if (envelope.type === 'search') {
        const queryVal = envelope.query || '';
        const filters = envelope.filters || {};
        
        let results = [];
        try {
          const runSearchFn = options.runSearch || runSearch;
          results = runSearchFn(db, {
            q: queryVal,
            type: filters.type,
            module: filters.module,
            category: filters.category,
            since: filters.since,
            kind: 'any'
          });
        } catch (searchErr) {
          results = [];
        }

        searches.push({
          query: queryVal,
          filters,
          resultCount: results.length
        });

        const compactResults = results.map((r: any) => ({
          id: r.id,
          ...(r.series && r.series !== 'E' ? { series: r.series } : {}), // a project note (SH-12), stage B1
          type: r.type,
          category: r.category,
          title: r.title,
          summary: r.summary,
          module: r.module,
          created_at: r.created_at,
          snippet: r.snippet
        }));

        llmMessages.push({
          role: 'user',
          content: `Search results for query "${queryVal}" with filters ${JSON.stringify(filters)}:\n${JSON.stringify(compactResults, null, 2)}`
        });

        currentIteration++;
      } else if (envelope.type === 'answer') {
        finalResponse = {
          answer: envelope.text || '',
          searches
        };
        break;
      } else if (envelope.type === 'draft') {
        const entry = envelope.entry || {};
        const errors = [];
        if (!entry.type || !KIND_BY_TYPE[entry.type as keyof typeof KIND_BY_TYPE]) {
          errors.push(`invalid type: ${entry.type}`);
        } else if (entry.type === 'rollup') {
          errors.push('rollup entries are system-generated; use collab.rollup');
        }

        if (!entry.title || !entry.title.trim()) {
          errors.push('title is required');
        }

        if (!entry.summary || !entry.summary.trim()) {
          errors.push('summary is required');
        } else if (entry.summary.length > 200) {
          errors.push(`summary exceeds 200 chars (got ${entry.summary.length})`);
        }

        const resolvedCategory = entry.category || (entry.type ? CATEGORY_BY_TYPE[entry.type as keyof typeof CATEGORY_BY_TYPE] : undefined);
        if (!resolvedCategory || !['Index', 'Reference', 'Activity'].includes(resolvedCategory)) {
          errors.push(`invalid category: ${resolvedCategory}`);
        }

        if (entry.module && !SLUG_REGEX.test(entry.module)) {
          errors.push(`invalid module slug: ${entry.module}`);
        }

        if (entry.modules && Array.isArray(entry.modules)) {
          for (const m of entry.modules) {
            if (m && !SLUG_REGEX.test(m)) {
              errors.push(`invalid module slug: ${m}`);
            }
          }
        }

        finalResponse = {
          draft: entry,
          validation: {
            ok: errors.length === 0,
            errors
          },
          searches
        };
        break;
      } else {
        finalResponse = {
          answer: `Received unknown response type: ${envelope.type}`,
          searches
        };
        break;
      }
    } catch (err: any) {
      if (send) {
        return send(500, { error: err.message });
      }
      throw err;
    }
  }

  if (!finalResponse) {
    finalResponse = {
      answer: "Iteration limit reached. I searched the database but could not form a final answer or draft in time.",
      searches
    };
  }

  if (send) {
    send(200, finalResponse);
  }
  return finalResponse;
}

export const routes = {
  'POST /api/ai/chat': async (req: http.IncomingMessage, res: http.ServerResponse, send: any, body: any) => {
    const db = getDb();
    await handleAiChat(req, res, db, { send, body });
  }
};
