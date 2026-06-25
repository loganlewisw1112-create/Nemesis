import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@nemesis/core': path.join(root, 'packages/core/src'),
      '@nemesis/ui': path.join(root, 'packages/ui/src'),
      '@nemesis/charts': path.join(root, 'packages/charts/src'),
      '@nemesis/connectors': path.join(root, 'packages/connectors/src'),
      '@nemesis/journal': path.join(root, 'packages/journal/src'),
      '@nemesis/pods': path.join(root, 'packages/pods/src'),
      '@nemesis/execution': path.join(root, 'packages/execution/src'),
      '@nemesis/capital': path.join(root, 'packages/capital/src'),
      '@nemesis/bridge-contracts': path.join(root, 'packages/bridge-contracts/src'),
      '@nemesis/brain-core': path.join(root, 'packages/brain-core/src'),
      '@nemesis/simulation-core': path.join(root, 'packages/simulation-core/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    environmentMatchGlobs: [
      ['apps/desktop/src/**/*.test.tsx', 'happy-dom'],
      ['apps/global-event-alpha/src/**/*.test.tsx', 'happy-dom'],
    ],
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'],
  },
});
