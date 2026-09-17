#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256, stable } = require('./lib/evidence-verifier.cjs');

const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]?.replace(/^--/, '');
  const value = process.argv[index + 1];
  if (!key || !value) throw new Error('Every readiness-receipt option requires an explicit value.');
  args[key] = path.resolve(value);
}
if (!args.body || !args.receipt) throw new Error('Missing --body or --receipt.');
const body = JSON.parse(fs.readFileSync(args.body, 'utf8').replace(/^\uFEFF/, ''));
if (body.receiptType !== 'ReadinessReceipt' || body.timerStarted !== false) throw new Error('Invalid readiness receipt body.');
const receipt = { ...body, receiptHash: sha256(JSON.stringify(stable(body))) };
fs.writeFileSync(args.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
