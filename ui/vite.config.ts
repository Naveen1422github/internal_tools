import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev: forward API calls to the Node backend on 7473.
      '/api': 'http://127.0.0.1:7473',
    },
  },
  build: { outDir: 'dist' },
  test: {
    environment: 'node',
    globals: true,
  },
});
