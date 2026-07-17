#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileHash, sha256, stable } = require('./lib/evidence-verifier.cjs');

const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]?.replace(/^--/, '');
  const value = process.argv[index + 1];
  if (!key || !value) throw new Error('Every receipt-check option requires an explicit value.');
  args[key] = key === 'run-type' ? value : path.resolve(value);
}
for (const key of ['receipt', 'result', 'run-type']) if (!args[key]) throw new Error(`Missing --${key}.`);

const receipt = JSON.parse(fs.readFileSync(args.receipt, 'utf8').replace(/^\uFEFF/, ''));
const result = JSON.parse(fs.readFileSync(args.result, 'utf8').replace(/^\uFEFF/, ''));
const body = { ...receipt };
delete body.receiptHash;
const expectedRunId = args['run-type'] === 'production-stress-soak' ? result.attemptId : result.runId;
const failures = [];
if (receipt.receiptType !== 'EvidenceVerificationReceipt') failures.push('receipt type is invalid');
if (receipt.runType !== args['run-type']) failures.push('receipt run type is invalid');
if (receipt.verified !== true || (Array.isArray(receipt.failures) && receipt.failures.length > 0)) failures.push('receipt does not record a clean pass');
if (!receipt.receiptHash || sha256(JSON.stringify(stable(body))) !== receipt.receiptHash) failures.push('receipt hash is invalid');
const requiredInputs = args['run-type'] === 'production-stress-soak'
  ? { result: 'result', manifest: 'manifest', samples: 'samples', runtimeStatus: 'runtime-status', cutoffStatus: 'cutoff-status' }
  : { ledger: 'ledger', runtimeLedger: 'runtime-ledger', result: 'result', summary: 'summary' };
for (const [receiptField, argumentName] of Object.entries(requiredInputs)) {
  if (!args[argumentName]) failures.push(`missing explicit --${argumentName}`);
  else if (receipt.inputHashes?.[receiptField] !== fileHash(args[argumentName])) failures.push(`receipt does not authenticate explicit ${argumentName}`);
}
if (!expectedRunId || receipt.runId !== expectedRunId) failures.push('receipt and result identities differ');
if (failures.length) {
  process.stderr.write(`FAIL ${failures.join('; ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`PASS ${args.receipt}\n`);
}
