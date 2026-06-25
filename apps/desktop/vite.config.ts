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
              external: ['ws', 'bufferutil', 'utf-8-validate'],
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
      '@nemesis/core': path.resolve(__dirname, '../../packages/core/src'),
      '@nemesis/ui': path.resolve(__dirname, '../../packages/ui/src'),
      '@nemesis/connectors': path.resolve(__dirname, '../../packages/connectors/src'),
      '@nemesis/journal': path.resolve(__dirname, '../../packages/journal/src'),
      '@nemesis/pods': path.resolve(__dirname, '../../packages/pods/src'),
      '@nemesis/execution': path.resolve(__dirname, '../../packages/execution/src'),
      '@nemesis/capital': path.resolve(__dirname, '../../packages/capital/src'),
      '@nemesis/charts': path.resolve(__dirname, '../../packages/charts/src'),
    },
  },
  optimizeDeps: {
    exclude: ['@nemesis/execution'],
    include: ['react-simple-maps'],
  },
  root: '.',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        index:  'index.html',
        widget: 'widget.html',
      },
    },
  },
});

