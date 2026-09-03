import { defineConfig } from 'vite';

// Relative base so the build can be opened from any path / static host.
export default defineConfig({
  base: './',
  server: { port: 5173, host: true },
  build: { outDir: 'dist', target: 'es2020' },
});
