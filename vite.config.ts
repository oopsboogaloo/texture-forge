import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Served from https://<user>.github.io/texture-forge/
export default defineConfig({
  base: '/texture-forge/',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        // The editor is the app; the probe stays reachable as a device
        // diagnostic, since it is the thing to run when an export misbehaves on
        // a machine we cannot inspect.
        main: resolve(import.meta.dirname, 'index.html'),
        probe: resolve(import.meta.dirname, 'probe.html'),
      },
    },
  },
  worker: { format: 'es' },
});
