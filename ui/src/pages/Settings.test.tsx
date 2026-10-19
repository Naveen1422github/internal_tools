// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// UI parity Task 11 (C): this laptop, the post office's address and start-at-login.
const VIEW = () => ({
  notebook: { name: 'main', path: '/data/main/notebook.db', described: 'notebook main (the default)' },
  device_id: 'd-0123456789', post_office: { url: 'https://192.168.1.10:7443', fingerprint: 'ab' },
  autostart: false, courier_notebook: '/data/main/notebook.db', courier_available: true, open_notebook: '/data/main/notebook.db',
});
const api = vi.hoisted(() => ({ settingsView: vi.fn(), settingsName: vi.fn(), settingsAddress: vi.fn(), settingsAutostart: vi.fn() }));
vi.mock('../api/client', () => api);

import Settings from './Settings';
import Toaster, { useToasts } from '../components/Toast';

function page(setup?: () => void) {
  api.settingsView.mockResolvedValue(VIEW());
  api.settingsName.mockResolvedValue({ name: 'Naveen', error: null });
  setup?.();
  render(<MemoryRouter><Settings /><Toaster /></MemoryRouter>);
}
const disabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;

describe('Settings page', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); useToasts.setState({ toasts: [] }); });

  it('shows the notebook, the member name and the device id, and the post office address', async () => {
    page();
    await screen.findByText('Naveen');
    screen.getByText('d-0123456789');
    screen.getByText(/notebook main \(the default\)/);
    screen.getByText('https://192.168.1.10:7443');
  });

  it('offline: the name says why it is unavailable; the device id still shows', async () => {
    page(() => api.settingsName.mockResolvedValue({ name: null, error: "Name unavailable: the post office can't be reached right now." }));
    await screen.findByText("Name unavailable: the post office can't be reached right now.");
    screen.getByText('d-0123456789');
  });

  it('the post office moved: checks and saves the new address; a refusal is shown word for word', async () => {
    const no = 'https://10.0.0.9:7443 answers with a different certificate, so it is not your post office. Nothing changed.';
    page(() => api.settingsAddress.mockRejectedValueOnce(Object.assign(new Error(no), { status: 409 }))
      .mockResolvedValueOnce({ url: 'https://10.0.0.5:7443', line: 'Post office address set to https://10.0.0.5:7443 (certificate checked: it is your post office). A running courier switches on its next retry.' }));
    const input = await screen.findByLabelText('The post office moved? Its new address');
    fireEvent.change(input, { target: { value: 'https://10.0.0.9:7443' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(no);
    fireEvent.change(input, { target: { value: 'https://10.0.0.5:7443' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and save' }));
    await screen.findByText(/^Post office address set to https:\/\/10\.0\.0\.5:7443/);
    expect(api.settingsAddress).toHaveBeenLastCalledWith('https://10.0.0.5:7443');
    expect(api.settingsView).toHaveBeenCalledTimes(2);
  });

  it('start sync at login: turns on through the courier; greyed with the reason when sync is not set up', async () => {
    page(() => api.settingsAutostart.mockResolvedValue({ on: true, lines: ['start at login: ON', '  runs collab sync run'] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(api.settingsAutostart).toHaveBeenCalledWith(true));
    await screen.findByText(/start at login: ON/);
    cleanup();
    page(() => api.settingsView.mockResolvedValue({ ...VIEW(), autostart: null }));
    const btn = await screen.findByRole('button', { name: 'Turn on' });
    expect(disabled(btn)).toBe(true);
    screen.getByText("This laptop isn't set up for sync yet, so there is nothing to start at login.");
  });

  it('a notebook with no post office says so, with no address form', async () => {
    page(() => api.settingsView.mockResolvedValue({ ...VIEW(), device_id: null, post_office: null, autostart: null }));
    await screen.findByText("This notebook isn't connected to a post office.");
    expect(screen.queryByLabelText('The post office moved? Its new address')).toBeNull();
  });
});
