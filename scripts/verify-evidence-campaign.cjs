#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCampaignReceipt, verifyCampaignEvidence } = require('./lib/campaign-evidence-verifier.cjs');

const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]?.replace(/^--/, '');
  const value = process.argv[index + 1];
  if (!key || !value) throw new Error('Every verifier option requires an explicit value.');
  args[key] = path.resolve(value);
}
for (const key of ['ledger', 'runtime-ledger', 'result', 'summary', 'receipt']) if (!args[key]) throw new Error(`Missing --${key}.`);
const paths = { ledger: args.ledger, runtimeLedger: args['runtime-ledger'], result: args.result, summary: args.summary };
const verification = verifyCampaignEvidence(paths);
const receipt = createCampaignReceipt(paths, verification);
fs.writeFileSync(args.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
process.stdout.write(`${receipt.verified ? 'PASS' : 'FAIL'} ${args.receipt}\n`);
if (!receipt.verified) process.exitCode = 1;
