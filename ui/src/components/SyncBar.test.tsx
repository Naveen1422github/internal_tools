// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ syncStatus: vi.fn() }));
vi.mock('../api/client', () => api);

import SyncBar from './SyncBar';

const on = (over: Record<string, unknown>) => ({
  enabled: true, postOffice: 'https://o', deviceId: 'd', sharedModules: [], unsent: 0, privateKept: 0, eAdopted: true,
  courier: { running: true, state: 'idle', lastError: null, lastPushAt: null, lastPullAt: null },
  lastContactAt: null, health: 'ok', ...over,
});
const show = () => render(<MemoryRouter><SyncBar /></MemoryRouter>);

describe('SyncBar: private E notes', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('adopted with private notes kept: says how many stay on this laptop', async () => {
    api.syncStatus.mockResolvedValue(on({ privateKept: 3 }));
    show();
    await screen.findByText('3 private E notes kept on this laptop');
  });

  it('one note reads in the singular; none says nothing', async () => {
    api.syncStatus.mockResolvedValue(on({ privateKept: 1 }));
    show();
    await screen.findByText('1 private E note kept on this laptop');
    cleanup();
    api.syncStatus.mockResolvedValue(on({ privateKept: 0 }));
    show();
    await screen.findByRole('status');
    expect(screen.queryByText(/private E note/)).toBeNull();
  });
});
