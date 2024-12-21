import { defineConfig } from 'vite';

export default defineConfig({
  root: './', // Project root directory
  publicDir: 'public', // Serve static assets from 'public' directory
  build: {
    outDir: 'dist', // Directory for build output
    emptyOutDir: true, // Clean the build directory before output
    rollupOptions: {
      external: ['fsevents'], // Exclude 'fsevents' to avoid build issues
    },
  },
  server: {
    port: 3000, // Local development server port
    open: true, // Automatically open browser
  },
});
