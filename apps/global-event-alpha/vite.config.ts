import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import path from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rollupOptions: {
              external: ['ws', 'bufferutil', 'utf-8-validate', 'better-sqlite3'],
            },
          },
        },
      },
      preload: { input: 'electron/preload.ts' },
    }),
  ],
  resolve: {
    alias: {
      '@nemesis/bridge-contracts': path.resolve(__dirname, '../../packages/bridge-contracts/src'),
      '@nemesis/brain-core': path.resolve(__dirname, '../../packages/brain-core/src'),
      '@nemesis/connectors': path.resolve(__dirname, '../../packages/connectors/src'),
      '@nemesis/core': path.resolve(__dirname, '../../packages/core/src'),
      '@nemesis/ui': path.resolve(__dirname, '../../packages/ui/src'),
      '@nemesis/simulation-core': path.resolve(__dirname, '../../packages/simulation-core/src'),
    },
  },
  optimizeDeps: {
    exclude: ['@nemesis/bridge-contracts'],
  },
  root: '.',
  server: {
    port: 5174,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
  },
});
