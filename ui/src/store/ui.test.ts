import { describe, it, expect, beforeEach } from 'vitest';
import { useUi } from './ui';

describe('ui store - ai chat', () => {
  beforeEach(() => useUi.getState().resetAiChat());

  it('appends turns and tracks busy', () => {
    useUi.getState().appendAiMessage({ role: 'user', content: 'hi' });
    useUi.getState().setAiBusy(true);
    expect(useUi.getState().aiMessages).toHaveLength(1);
    expect(useUi.getState().aiMessages[0]).toEqual({ role: 'user', content: 'hi' });
    expect(useUi.getState().aiBusy).toBe(true);
  });

  it('stores parsed response on assistant turns', () => {
    useUi.getState().appendAiMessage({ role: 'assistant', content: '{"answer":"ok","searches":[]}', parsed: { answer: 'ok', searches: [] } });
    expect(useUi.getState().aiMessages[0].parsed).toEqual({ answer: 'ok', searches: [] });
  });

  it('resetAiChat clears history and busy', () => {
    useUi.getState().appendAiMessage({ role: 'user', content: 'hi' });
    useUi.getState().setAiBusy(true);
    useUi.getState().resetAiChat();
    expect(useUi.getState().aiMessages).toEqual([]);
    expect(useUi.getState().aiBusy).toBe(false);
  });
});
