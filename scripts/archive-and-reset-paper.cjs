#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-paper-reset-'));
const bundlePath = path.join(tempDir, 'archive-and-reset-paper.mjs');

try {
  buildSync({
    entryPoints: [path.join(__dirname, 'archive-and-reset-paper.mjs')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
  });
  const result = spawnSync(process.execPath, [bundlePath, ...process.argv.slice(2)], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, NEMESIS_REPO_ROOT: repoRoot },
  });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
