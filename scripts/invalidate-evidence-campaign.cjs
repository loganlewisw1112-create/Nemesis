#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-campaign-invalidate-'));
const bundlePath = path.join(tempDir, 'invalidate-evidence-campaign.mjs');

try {
  buildSync({
    entryPoints: [path.join(__dirname, 'invalidate-evidence-campaign.mjs')],
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
    env: process.env,
  });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
