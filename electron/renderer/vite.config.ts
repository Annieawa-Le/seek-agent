import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: './',
  root: dirname,
  resolve: {
    alias: {
      '@': path.resolve(dirname, 'src'),
    },
  },
  build: {
    outDir: path.resolve(dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(dirname, 'index.html'),
    },
  },
});
