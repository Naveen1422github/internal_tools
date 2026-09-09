import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { aiChat, isDraft } from '../api/client';
import { useUi, type ChatTurn } from '../store/ui';
import DraftCard from './DraftCard';

export default function AiPanel() {
  const { aiMessages, aiBusy, appendAiMessage, setAiBusy, resetAiChat, toggleAiPanel } = useUi();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [aiMessages, aiBusy]);

  const send = async () => {
    const text = input.trim();
    if (!text || aiBusy) return;
    setError(null);
    const userTurn: ChatTurn = { role: 'user', content: text };
    appendAiMessage(userTurn);
    setInput('');
    setAiBusy(true);
    try {
      const history = [...aiMessages, userTurn].map((t) => ({ role: t.role, content: t.content }));
      const res = await aiChat(history);
      const content = isDraft(res) ? JSON.stringify(res.draft) : res.answer;
      appendAiMessage({ role: 'assistant', content, parsed: res });
    } catch (e: any) {
      setError(e?.message || 'The assistant hit an error.');
    } finally {
      setAiBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const notConfigured = error && /not configured/i.test(error);

  return (
    <aside className="w-96 shrink-0 border-l border-gray-200 dark:border-gray-800 flex flex-col h-full">
      <header className="h-12 shrink-0 px-4 flex items-center justify-between border-b border-gray-100 dark:border-gray-800">
        <span className="text-sm font-semibold">AI Assistant</span>
        <div className="flex items-center gap-3 text-xs">
          <button onClick={resetAiChat} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">New chat</button>
          <button onClick={toggleAiPanel} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">Close</button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {aiMessages.length === 0 && !aiBusy && (
          <p className="text-sm text-gray-400">Ask about the knowledge base, or ask me to draft an entry.</p>
        )}
        {aiMessages.map((t, i) => (
          <Turn key={i} turn={t} />
        ))}
        {aiBusy && <p className="text-sm text-gray-400 animate-pulse">Thinking...</p>}
        {error && (
          <div className={`text-sm rounded p-3 ${notConfigured ? 'bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200' : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'}`}>
            {notConfigured ? 'AI is not configured - set GROQ_API_KEY on the server.' : `The assistant hit an error: ${error}`}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="shrink-0 border-t border-gray-100 dark:border-gray-800 p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask the assistant...  (Enter to send, Shift+Enter for newline)"
          rows={2}
          disabled={aiBusy}
          className="w-full text-sm bg-transparent border border-gray-200 dark:border-gray-800 rounded p-2 outline-none focus:ring-2 focus:ring-blue-500/20 resize-none"
        />
        <button
          onClick={send}
          disabled={aiBusy || !input.trim()}
          className="mt-2 w-full py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Send
        </button>
      </div>
    </aside>
  );
}

function Turn({ turn }: { turn: ChatTurn }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-blue-600 text-white rounded-lg px-3 py-2 text-sm whitespace-pre-wrap">{turn.content}</div>
      </div>
    );
  }
  const res = turn.parsed;
  return (
    <div className="space-y-2">
      {res && isDraft(res) ? (
        <DraftCard draft={res.draft} validation={res.validation} />
      ) : (
        <div className="max-w-[95%] bg-gray-50 dark:bg-gray-900 rounded-lg px-3 py-2 text-sm prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown>{res && !isDraft(res) ? res.answer : turn.content}</ReactMarkdown>
        </div>
      )}
      {res && res.searches.length > 0 && <SearchTrail searches={res.searches} />}
    </div>
  );
}

function SearchTrail({ searches }: { searches: { query: string; resultCount: number }[] }) {
  return (
    <details className="text-[11px] text-gray-400">
      <summary className="cursor-pointer select-none">searched {searches.length}x</summary>
      <ul className="mt-1 space-y-0.5 pl-2">
        {searches.map((s, i) => (
          <li key={i} className="font-mono">"{s.query}" -&gt; {s.resultCount} results</li>
        ))}
      </ul>
    </details>
  );
}
