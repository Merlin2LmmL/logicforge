import { defineConfig } from 'vite';

const REPO_NAME = 'logicforge';

export default defineConfig({
  base: process.env.VITE_BASE || `/${REPO_NAME}/`,
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
  },
  server: {
    port: 5000,
    host: true,
    allowedHosts: true,
    open: false,
  },
});
