import { defineConfig } from 'vite';

export default defineConfig({
  root: './', // Project root directory
  publicDir: 'public', // Static assets directory
  build: {
    outDir: 'dist', // Output directory
    emptyOutDir: true, // Clean before build
    rollupOptions: {
      external: ['node:fs', 'node:path', 'node:url'], // Externalize problematic modules
    },
  },
  server: {
    port: 3000, // Dev server port
    open: true, // Open in browser
  },
});
