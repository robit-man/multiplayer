import { defineConfig } from 'vite';

export default defineConfig({
  assetsInclude: ['**/*.glb'], // Include .glb as assets
  publicDir: 'public', // Define the public directory to copy from
  build: {
    outDir: 'dist', // Specify the build output directory
    rollupOptions: {
      input: {
        main: './index.html', // Main entry file
      },
      output: {
        assetFileNames: (assetInfo) => {
          // Check if the file is in /public and place it in a /public folder inside dist
          const ext = assetInfo.name.split('.').pop();
          if (ext === 'glb') {
            return 'public/[name][extname]'; // Keep .glb in /dist/public
          }
          return '[name][extname]'; // Default for other assets
        },
      },
    },
  },
});
