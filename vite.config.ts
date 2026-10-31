import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// base './' — работает и на GitHub Pages (/sor-reports/), и локально
export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
});
