import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// base './' — работает и на GitHub Pages (/sor-reports/), и локально
export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
});
