#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createReceipt, verifySoakEvidence } = require('./lib/evidence-verifier.cjs');

function argumentsByName(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    const value = argv[index + 1];
    if (!key || !value) throw new Error('Every verifier option requires an explicit value.');
    values[key] = path.resolve(value);
  }
  return values;
}

const inputs = argumentsByName(process.argv.slice(2));
for (const required of ['result', 'manifest', 'samples', 'runtime-status', 'cutoff-status', 'receipt']) {
  if (!inputs[required]) throw new Error(`Missing explicit --${required} input.`);
}
const paths = {
  result: inputs.result,
  manifest: inputs.manifest,
  samples: inputs.samples,
  runtimeStatus: inputs['runtime-status'],
  cutoffStatus: inputs['cutoff-status'],
};
const verification = verifySoakEvidence(paths);
const receipt = createReceipt(paths, verification);
fs.mkdirSync(path.dirname(inputs.receipt), { recursive: true });
fs.writeFileSync(inputs.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
process.stdout.write(`${receipt.verified ? 'PASS' : 'FAIL'} ${inputs.receipt}\n`);
if (!receipt.verified) process.exitCode = 1;
