import { defineConfig, type Plugin } from 'vite';
import { resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

/** Только локальный запуск: POST /__save?name=… кладёт книгу в «Загрузки» (встроенное окно может не уметь скачивать). */
const saveDownloads = (): Plugin => ({
  name: 'save-downloads',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__save', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      const name = basename(new URL(req.url ?? '', 'http://x').searchParams.get('name') || 'report.xlsx').replace(/[<>:"|?*]/g, '_');
      if (!/\.xlsx$/i.test(name)) { res.statusCode = 400; res.end(); return; }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const dir = join(homedir(), 'Downloads');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        let file = join(dir, name), i = 2;
        while (existsSync(file)) file = join(dir, name.replace(/\.xlsx$/i, ` (${i++}).xlsx`));
        writeFileSync(file, Buffer.concat(chunks));
        res.setHeader('content-type', 'text/plain; charset=utf-8'); res.end(file);
      });
    });
  },
});

// base './' — работает и на GitHub Pages (/sor-reports/), и локально
export default defineConfig({
  base: './',
  plugins: [saveDownloads()],
  build: {
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
});
