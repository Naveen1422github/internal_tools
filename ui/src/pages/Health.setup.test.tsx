// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../api/client', () => ({
  doctor: vi.fn(async () => ({ ok: true, checks: [] })),
  reassignModule: vi.fn(),
  upsertEntry: vi.fn(),
  setupDoctor: vi.fn(async () => ({
    checks: [{ group: 'install', id: 'install.addon', mark: 'error', text: 'Sync add-on missing', fix: 'collab doctor --fix' }],
    errors: 1, warnings: 0, exitCode: 2, notebook: null,
  })),
}));

import Health from './Health';

describe('Health page: setup report', () => {
  afterEach(() => cleanup());

  it('shows each problem with its fix in a code element, and the same summary as the terminal', async () => {
    render(<MemoryRouter><Health /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Sync add-on missing')).toBeTruthy());
    const fix = screen.getByText('collab doctor --fix');
    expect(fix.tagName).toBe('CODE');
    expect(screen.getByText('1 problem(s), 0 warning(s).')).toBeTruthy();
  });
});
