// SKIP until user installs: @testing-library/react @testing-library/jest-dom jsdom react-markdown + sets vite.config test.environment='jsdom'
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DraftCard from './DraftCard';
import * as client from '../api/client';

const baseDraft = { type: 'gotcha', title: 'Test gotcha', summary: 'short summary', description: 'details' };

describe.skip('DraftCard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves an edited draft via upsertEntry and shows the new id', async () => {
    const spy = vi.spyOn(client, 'upsertEntry').mockResolvedValue({ ok: true, id: 321 });
    render(<DraftCard draft={baseDraft} validation={{ ok: true, errors: [] }} />);
    fireEvent.click(screen.getByRole('button', { name: /approve & save/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: 'gotcha', title: 'Test gotcha' })));
    await waitFor(() => expect(screen.getByText(/E-00321/)).toBeInTheDocument());
  });

  it('blocks save when summary exceeds 200 chars', () => {
    const longSummary = 'x'.repeat(201);
    render(<DraftCard draft={{ ...baseDraft, summary: longSummary }} validation={{ ok: false, errors: ['summary exceeds 200 chars'] }} />);
    expect(screen.getByRole('button', { name: /approve & save/i })).toBeDisabled();
    expect(screen.getByText(/200/)).toBeInTheDocument();
  });
});
