import { defineConfig } from 'vite';

// base './' — работает и на GitHub Pages (/sor-reports/), и локально
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1600 },
});
