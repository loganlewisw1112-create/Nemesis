#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { verifySoakEvidence } = require('./lib/evidence-verifier.cjs');

const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]?.replace(/^--/, '');
  const value = process.argv[index + 1];
  if (!key || !value) throw new Error('Every verifier option requires an explicit value.');
  args[key] = path.resolve(value);
}
for (const key of ['result', 'manifest', 'samples', 'runtime-status', 'cutoff-status']) if (!args[key]) throw new Error(`Missing --${key}.`);
const verification = verifySoakEvidence({
  result: args.result, manifest: args.manifest, samples: args.samples,
  runtimeStatus: args['runtime-status'], cutoffStatus: args['cutoff-status'],
});
if (verification.failures.length) {
  process.stderr.write(`FAIL ${verification.failures.join('; ')}\n`);
  process.exitCode = 1;
} else process.stdout.write('PASS explicit soak evidence\n');
