// SKIP until user installs: @testing-library/react @testing-library/jest-dom jsdom react-markdown + sets vite.config test.environment='jsdom'
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AiPanel from './AiPanel';
import { useUi } from '../store/ui';
import * as client from '../api/client';

describe.skip('AiPanel', () => {
  afterEach(() => { vi.restoreAllMocks(); useUi.getState().resetAiChat(); });

  it('sends a message and renders a markdown answer', async () => {
    vi.spyOn(client, 'aiChat').mockResolvedValue({ answer: 'Hello **bold**', searches: [] });
    render(<AiPanel />);
    fireEvent.change(screen.getByPlaceholderText(/ask/i), { target: { value: 'hi there' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('hi there')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('bold')).toBeInTheDocument()); // markdown rendered
  });

  it('shows a not-configured notice on 503', async () => {
    vi.spyOn(client, 'aiChat').mockRejectedValue(new Error('AI not configured (set GROQ_API_KEY)'));
    render(<AiPanel />);
    fireEvent.change(screen.getByPlaceholderText(/ask/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/not configured/i)).toBeInTheDocument());
  });
});
