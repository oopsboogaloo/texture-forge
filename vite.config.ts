import { defineConfig } from 'vite';

// Served from https://<user>.github.io/texture-forge/
export default defineConfig({
  base: '/texture-forge/',
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
