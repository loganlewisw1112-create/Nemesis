#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sha256, stable } = require('./lib/evidence-verifier.cjs');

const receiptPath = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(receiptPath)) throw new Error('An explicit readiness receipt path is required.');
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8').replace(/^\uFEFF/, ''));
const body = { ...receipt };
delete body.receiptHash;
const failures = [];
if (receipt.receiptType !== 'ReadinessReceipt' || receipt.timerStarted !== false) failures.push('receipt identity is invalid');
if (!receipt.receiptHash || sha256(JSON.stringify(stable(body))) !== receipt.receiptHash) failures.push('receipt hash is invalid');
// Default-on: a readiness receipt that verifies but did not pass must fail
// here so no caller can treat an unpassed hold as qualification evidence.
if (!process.argv.includes('--allow-unpassed') && receipt.passed !== true) failures.push('receipt has not passed');
if (failures.length) {
  process.stderr.write(`FAIL ${failures.join('; ')}\n`);
  process.exitCode = 1;
} else process.stdout.write(`PASS ${receiptPath}\n`);
