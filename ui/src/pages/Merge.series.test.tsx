// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Stage B1: the merge page is /merge/:ref; /merge/3 keeps working.
const api = vi.hoisted(() => ({
  mergeVersions: vi.fn(async (ref: number | string) => ({
    id: typeof ref === 'number' ? ref : 3,
    current: { title: 't', summary: 's', description: null },
    heads: [],
  })),
  resolveMerge: vi.fn(),
  explainMerge: vi.fn(),
  VERSIONS_CHANGED: 'versions-changed',
}));
vi.mock('../api/client', () => api);

import Merge from './Merge';

function at(path: string) {
  render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/merge/:ref" element={<Merge />} /></Routes></MemoryRouter>);
}

describe('Merge page by reference', () => {
  afterEach(() => { cleanup(); api.mergeVersions.mockClear(); });

  it('/merge/3 loads E-00003 by number', async () => {
    at('/merge/3');
    await waitFor(() => screen.getByText('E-00003'));
    expect(api.mergeVersions).toHaveBeenCalledWith(3);
  });

  it('/merge/SH-3 loads SH-3 by reference', async () => {
    at('/merge/SH-3');
    await waitFor(() => screen.getByText('SH-3'));
    expect(api.mergeVersions).toHaveBeenCalledWith('SH-3');
  });

  it('/merge/nonsense says so instead of loading', async () => {
    at('/merge/nonsense');
    await waitFor(() => screen.getByText(/not a note number/));
    expect(api.mergeVersions).not.toHaveBeenCalled();
  });
});
