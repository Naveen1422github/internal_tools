import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Same path rule as server/src/web-key.ts (kept in sync by hand: the UI's
// TypeScript project cannot import from server/).
function readWebKey(): string | null {
  const file = process.env.COLLAB_WEB_KEY_FILE || join(
    process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')) : join(homedir(), '.local', 'share'),
    'collab', 'web', 'key',
  );
  try { return readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev: forward API calls to the Node backend on 7473 with its access key.
      '/api': {
        target: 'http://127.0.0.1:7473',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const key = readWebKey(); // per request: the key changes on every server restart
            if (key) proxyReq.setHeader('x-collab-key', key);
            proxyReq.removeHeader('origin'); // the dev page's origin (port 5173) is not the server's
          });
        },
      },
    },
  },
  build: { outDir: 'dist' },
  test: {
    environment: 'node',
    globals: true,
  },
});
